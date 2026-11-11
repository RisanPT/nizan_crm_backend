/**
 * leaveCallbackService.js
 *
 * Dispatches outbound decision webhooks to the external app (e.g. Timebox / PHP Portal)
 * when a LeaveRequest is approved or rejected by a manager / HR in Nizan CRM.
 *
 * External app specification:
 *   POST https://<your-domain>/modules/api/leave_callback.php
 *   Authorization: Bearer <callback_token> (or X-API-Key: <callback_token>)
 *   Content-Type: application/json
 *   Body: { "request_id": 123, "status": "approved", "approver": "Jane Doe", "note": "Enjoy!" }
 */

import LeaveRequest from '../models/LeaveRequest.js';

export async function dispatchLeaveCallback(leaveRequest, options = {}) {
  if (!leaveRequest) return { sent: false, reason: 'No leave request provided' };

  const callbackUrl = String(leaveRequest.callbackUrl || '').trim();
  const requestId = leaveRequest.externalRequestId;

  if (!callbackUrl || requestId == null) {
    return { sent: false, reason: 'Not an external request (no callbackUrl or externalRequestId)' };
  }

  const status = leaveRequest.status === 'approved' ? 'approved' : 'rejected';
  const approver = String(
    options.approver ||
    options.approverName ||
    leaveRequest.decisionNoteApprover ||
    'HR Team'
  ).trim();
  const note = String(options.note ?? leaveRequest.decisionNote ?? '').trim();

  const payload = {
    request_id: Number(requestId),
    status,
    ...(approver ? { approver } : {}),
    ...(note ? { note } : {}),
  };

  const token = process.env.TIMEBOX_CALLBACK_TOKEN || '';

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'NizanCRM-LeaveWebhook/2.0',
    ...(token
      ? {
          Authorization: `Bearer ${token}`,
          'X-API-Key': token,
        }
      : {}),
  };

  console.log(`[Leave Callback] Dispatching decision for request_id: ${requestId} to ${callbackUrl}`, payload);

  try {
    leaveRequest.callbackStatus = 'pending';
    await leaveRequest.save();

    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000), // 12-second timeout
    });

    const responseText = await response.text();
    let responseData = null;
    try {
      responseData = JSON.parse(responseText);
    } catch (_) {
      responseData = responseText.slice(0, 500);
    }

    if (!response.ok) {
      const errMsg = `HTTP ${response.status}: ${typeof responseData === 'object' ? JSON.stringify(responseData) : responseText.slice(0, 200)}`;
      console.warn(`[Leave Callback] External server returned error for request_id ${requestId}:`, errMsg);

      await LeaveRequest.updateOne(
        { _id: leaveRequest._id },
        {
          $set: {
            callbackStatus: 'failed',
            callbackError: errMsg,
            callbackResponse: responseData,
          },
        }
      );

      return {
        sent: false,
        statusCode: response.status,
        error: errMsg,
        data: responseData,
      };
    }

    console.log(`[Leave Callback] Successfully delivered callback for request_id ${requestId}:`, responseData);

    await LeaveRequest.updateOne(
      { _id: leaveRequest._id },
      {
        $set: {
          callbackStatus: 'delivered',
          callbackDeliveredAt: new Date(),
          callbackError: '',
          callbackResponse: responseData,
        },
      }
    );

    return {
      sent: true,
      statusCode: response.status,
      data: responseData,
    };
  } catch (err) {
    const errMsg = err?.message || String(err);
    console.error(`[Leave Callback] Network or system error reaching ${callbackUrl}:`, errMsg);

    await LeaveRequest.updateOne(
      { _id: leaveRequest._id },
      {
        $set: {
          callbackStatus: 'failed',
          callbackError: errMsg,
        },
      }
    );

    return {
      sent: false,
      error: errMsg,
    };
  }
}
