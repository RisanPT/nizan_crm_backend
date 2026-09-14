import asyncHandler from 'express-async-handler';
import Ticket from '../models/Ticket.js';
import ITTask from '../models/ITTask.js';
import Project from '../models/Project.js';
import { notify, notifyPermission, getUserIdsByEmployeeIds } from '../utils/notify.js';
import { permissionsForRole } from './roleController.js';

// Role keys that are IT staff without a permission lookup (fast path).
const IT_ROLE_KEYS = new Set(['it', 'admin', 'manager']);

// IT staff = admin/manager/it OR ANY role granted the 'it' feature permission.
// This is permission-driven (not a hardcoded role list), so a custom role such
// as "Project Head" created in the Roles screen with the IT feature ticked gets
// full IT/ticket powers automatically — matching the frontend `canSeeIt` gate.
const isITStaff = async (u) => {
  if (!u) return false;
  if (IT_ROLE_KEYS.has(u.role)) return true;
  try {
    return (await permissionsForRole(u.role)).includes('it');
  } catch {
    return false;
  }
};

// Visibility: IT sees ALL tickets (to triage); everyone else sees ONLY the
// tickets they raised themselves — not their whole department's.
const visibilityMatch = async (user) => {
  if (await isITStaff(user)) return {};
  return { raisedBy: user._id };
};

const canView = async (user, ticket) => {
  if (await isITStaff(user)) return true;
  return String(ticket.raisedBy) === String(user._id);
};

const linkOf = (id) => `/helpdesk/tickets/${id}`;

// @route POST /api/tickets — anyone raises a bug / feature / support ticket.
export const createTicket = asyncHandler(async (req, res) => {
  const { title, description, type, priority, module, screenshots } = req.body;
  if (!title || !String(title).trim()) { res.status(400); throw new Error('Title is required'); }

  const ticket = await Ticket.create({
    title: String(title).trim(),
    description: String(description ?? '').trim(),
    type: ['bug', 'feature', 'support'].includes(type) ? type : 'bug',
    priority: ['low', 'medium', 'high', 'critical'].includes(priority) ? priority : 'medium',
    module: String(module ?? '').trim(),
    screenshots: Array.isArray(screenshots) ? screenshots.filter((u) => String(u ?? '').trim()) : [],
    raisedBy: req.user._id,
    raisedByName: req.user.name || '',
    departmentId: req.user.departmentId || null,
    activity: [{ by: req.user._id, byName: req.user.name || '', kind: 'created', text: 'Ticket raised', at: new Date() }],
  });

  // Notify the IT team — everyone whose role grants the `it` permission
  // (the built-in `it` role plus any custom role like "Project Head").
  try {
    await notifyPermission({
      permission: 'it',
      type: 'ticket_created',
      title: `New ${ticket.type} ticket`,
      body: `${ticket.ticketNumber}: ${ticket.title}`,
      link: linkOf(ticket._id),
      createdBy: req.user._id,
      excludeUserId: req.user._id,
    });
  } catch (err) {
    console.error('ticket_created notify failed:', err.message);
  }

  res.status(201).json(ticket);
});

// @route GET /api/tickets — visibility-scoped list with filters.
export const getTickets = asyncHandler(async (req, res) => {
  const match = { ...(await visibilityMatch(req.user)) };
  if (req.query.status) match.status = req.query.status;
  if (req.query.type) match.type = req.query.type;
  if (req.query.priority) match.priority = req.query.priority;
  if (req.query.mine === 'true') match.raisedBy = req.user._id;
  if (req.query.assignee) match.assignedTo = req.query.assignee;

  const tickets = await Ticket.find(match).sort({ createdAt: -1 }).limit(2000).lean();
  res.json(tickets);
});

// @route GET /api/tickets/stats — IT dashboard counters.
export const getTicketStats = asyncHandler(async (req, res) => {
  if (!(await isITStaff(req.user))) { res.status(403); throw new Error('Only IT can view ticket stats'); }
  const [total, open, inProgress, resolved, critical, unassigned] = await Promise.all([
    Ticket.countDocuments({}),
    Ticket.countDocuments({ status: 'open' }),
    Ticket.countDocuments({ status: 'in-progress' }),
    Ticket.countDocuments({ status: { $in: ['resolved', 'closed'] } }),
    Ticket.countDocuments({ priority: 'critical', status: { $nin: ['resolved', 'closed', 'rejected'] } }),
    Ticket.countDocuments({ assignedTo: null, status: { $nin: ['resolved', 'closed', 'rejected'] } }),
  ]);
  res.json({ total, open, inProgress, resolved, critical, unassigned });
});

// @route GET /api/tickets/:id
export const getTicketById = asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id).lean();
  if (!ticket) { res.status(404); throw new Error('Ticket not found'); }
  if (!(await canView(req.user, ticket))) { res.status(403); throw new Error('Not allowed to view this ticket'); }
  res.json(ticket);
});

// @route PUT /api/tickets/:id — IT triages (status / priority / assignee / resolution).
export const updateTicket = asyncHandler(async (req, res) => {
  if (!(await isITStaff(req.user))) { res.status(403); throw new Error('Only IT can update tickets'); }
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) { res.status(404); throw new Error('Ticket not found'); }

  const changes = [];
  if (req.body.status && req.body.status !== ticket.status) {
    changes.push(`status → ${req.body.status}`);
    ticket.status = req.body.status;
    if (['resolved', 'closed'].includes(req.body.status)) {
      ticket.resolvedBy = req.user._id;
      ticket.resolvedAt = new Date();
    }
  }
  if (req.body.priority && req.body.priority !== ticket.priority) {
    changes.push(`priority → ${req.body.priority}`);
    ticket.priority = req.body.priority;
  }
  if (req.body.assignedTo !== undefined) {
    ticket.assignedTo = req.body.assignedTo || null;
    ticket.assignedToName = req.body.assignedToName || '';
    changes.push(ticket.assignedTo ? `assigned to ${ticket.assignedToName || 'IT'}` : 'unassigned');
  }
  if (req.body.resolution !== undefined) ticket.resolution = String(req.body.resolution);

  if (changes.length) {
    ticket.activity.push({ by: req.user._id, byName: req.user.name || '', kind: 'status', text: changes.join(' · '), at: new Date() });
  }
  await ticket.save();

  try {
    const recipients = [ticket.raisedBy];
    if (ticket.assignedTo) {
      const [assigneeUserId] = await getUserIdsByEmployeeIds([ticket.assignedTo]);
      if (assigneeUserId && String(assigneeUserId) !== String(ticket.raisedBy)) recipients.push(assigneeUserId);
    }
    await notify({
      recipients,
      type: 'ticket_updated',
      title: `Ticket ${ticket.ticketNumber} updated`,
      body: changes.join(' · ') || 'Ticket updated',
      link: linkOf(ticket._id),
      createdBy: req.user._id,
      excludeUserId: req.user._id,
    });
  } catch (err) {
    console.error('ticket_updated notify failed:', err.message);
  }

  res.json(ticket);
});

// Ticket type → IT task category.
const typeToCategory = (t) => (t === 'bug' ? 'bug' : t === 'support' ? 'maintenance' : 'feature');

// @route POST /api/tickets/:id/promote — IT converts a ticket into an IT task.
export const promoteToTask = asyncHandler(async (req, res) => {
  if (!(await isITStaff(req.user))) { res.status(403); throw new Error('Only IT can convert tickets to tasks'); }
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) { res.status(404); throw new Error('Ticket not found'); }
  if (ticket.linkedTaskId) { res.status(400); throw new Error('This ticket is already linked to a task'); }

  const { projectId, assignedTo, assignedToName } = req.body;
  if (!projectId) { res.status(400); throw new Error('Pick a project for the task'); }
  const assignee = assignedTo || ticket.assignedTo;
  if (!assignee) { res.status(400); throw new Error('Pick an assignee for the task'); }
  const project = await Project.findById(projectId);
  if (!project) { res.status(404); throw new Error('Project not found'); }

  const severityMap = {
    critical: 'p0',
    high: 'p1',
    medium: 'p2',
    low: 'p3',
  };

  const task = await ITTask.create({
    projectId,
    title: ticket.title,
    description: `From ${ticket.ticketNumber}${ticket.description ? `\n\n${ticket.description}` : ''}`,
    assignedTo: assignee,
    status: 'todo',
    priority: ticket.priority,
    severity: severityMap[ticket.priority] || 'p2',
    ticketType: ticket.type === 'bug' ? 'bug' : ticket.type === 'feature' ? 'feature' : 'tech-debt',
    category: typeToCategory(ticket.type),
    subTeam: 'general',
    percentComplete: 0,
    startDate: new Date(),
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    activityLogs: [
      {
        message: `Task created from ticket ${ticket.ticketNumber}`,
        author: req.user.name || 'IT Staff',
        type: 'status_change',
        timestamp: new Date(),
      },
    ],
  });

  ticket.linkedTaskId = task._id;
  if (assignedTo) { ticket.assignedTo = assignedTo; ticket.assignedToName = assignedToName || ticket.assignedToName; }
  if (ticket.status === 'open') ticket.status = 'in-progress';
  ticket.activity.push({
    by: req.user._id, byName: req.user.name || '', kind: 'status',
    text: `Converted to a task in "${project.name}"`, at: new Date(),
  });
  await ticket.save();

  // Let the raiser know their ticket is being worked on.
  try {
    await notify({
      recipients: [ticket.raisedBy],
      type: 'ticket_updated',
      title: `Ticket ${ticket.ticketNumber} accepted`,
      body: `Converted to a task in ${project.name}`,
      link: linkOf(ticket._id),
      createdBy: req.user._id,
      excludeUserId: req.user._id,
    });
  } catch (err) {
    console.error('ticket promote notify failed:', err.message);
  }

  res.status(201).json(ticket);
});

// @route POST /api/tickets/:id/comments — raiser / same-dept / IT adds a comment.
export const addComment = asyncHandler(async (req, res) => {
  const text = String(req.body.text ?? '').trim();
  if (!text) { res.status(400); throw new Error('Comment cannot be empty'); }
  const ticket = await Ticket.findById(req.params.id);
  if (!ticket) { res.status(404); throw new Error('Ticket not found'); }
  if (!(await canView(req.user, ticket))) { res.status(403); throw new Error('Not allowed to comment on this ticket'); }

  ticket.activity.push({ by: req.user._id, byName: req.user.name || '', kind: 'comment', text, at: new Date() });
  await ticket.save();

  try {
    const recipients = [];
    if (String(ticket.raisedBy) !== String(req.user._id)) recipients.push(ticket.raisedBy);
    if (ticket.assignedTo) {
      const [assigneeUserId] = await getUserIdsByEmployeeIds([ticket.assignedTo]);
      if (assigneeUserId &&
          String(assigneeUserId) !== String(req.user._id) &&
          String(assigneeUserId) !== String(ticket.raisedBy)) {
        recipients.push(assigneeUserId);
      }
    }
    if (recipients.length) {
      await notify({
        recipients, type: 'ticket_comment',
        title: `New comment on ${ticket.ticketNumber}`,
        body: text.length > 80 ? `${text.slice(0, 80)}…` : text,
        link: linkOf(ticket._id), createdBy: req.user._id, excludeUserId: req.user._id,
      });
    } else {
      // Raiser commented and nobody's assigned yet → ping IT.
      await notifyPermission({
        permission: 'it', type: 'ticket_comment',
        title: `New comment on ${ticket.ticketNumber}`,
        body: text.length > 80 ? `${text.slice(0, 80)}…` : text,
        link: linkOf(ticket._id), createdBy: req.user._id, excludeUserId: req.user._id,
      });
    }
  } catch (err) {
    console.error('ticket_comment notify failed:', err.message);
  }

  res.json(ticket);
});
