// In-app help bot. Answers "how do I…?" from the editable manual in
// data/helpManual.json only — it never touches the database or business data.
// With GEMINI_API_KEY set, Gemini phrases the answer from the matching manual
// entries; without it (or if Gemini fails) a plain keyword search answers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MANUAL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/helpManual.json');

let cache = null;
export function loadManual() {
  if (!cache) cache = JSON.parse(readFileSync(MANUAL_PATH, 'utf8')).entries;
  return cache;
}
export function resetManualCache() { cache = null; }

const STOP = new Set(['how', 'do', 'i', 'to', 'the', 'a', 'an', 'is', 'are', 'can', 'of', 'in', 'on', 'for', 'my', 'me',
  'where', 'what', 'which', 'and', 'or', 'it', 'this', 'that', 'you', 'we', 'please', 'want', 'need', 'show', 'open', 'go', 'find',
  'get', 'make', 'with', 'from', 'at', 'be', 'does', 'should', 'would', 'create']);

const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
export const tokens = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9ഀ-ൿ\s]/g, ' ').split(/\s+/)
    .filter((w) => w && !STOP.has(w)).map(stem);

function scoreEntry(e, qTokens, qText) {
  const title = tokens(e.title);
  const kw = (e.keywords || []).map((k) => String(k).toLowerCase());
  const kwTokens = kw.flatMap(tokens);
  const body = tokens(`${e.summary} ${(e.steps || []).join(' ')} ${e.menuPath} ${e.module}`);
  let score = 0;
  for (const t of qTokens) {
    if (title.includes(t)) score += 5;
    if (kwTokens.includes(t)) score += 4;
    if (body.includes(t)) score += 1;
  }
  // Whole keyword phrases ("cash in", "credit note") are strong signals.
  for (const k of kw) if (k.includes(' ') && qText.includes(k)) score += 6;
  return score;
}

export function rank(question, entries, limit = 8) {
  const qText = String(question || '').toLowerCase();
  const qTokens = tokens(question);
  return entries
    .map((e) => ({ e, s: scoreEntry(e, qTokens, qText) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

export const linkOf = (e) => ({ id: e.id, title: e.title, route: e.route || null, menuPath: e.menuPath, inPage: e.inPage || null });

export function formatEntry(e) {
  const steps = (e.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
  const tips = (e.tips || []).map((t) => `Tip: ${t}`).join('\n');
  return [`${e.title}`, `Menu: ${e.menuPath}`, steps, tips].filter(Boolean).join('\n');
}

export function searchAnswer(question, allowed) {
  const hits = rank(question, allowed, 4);
  if (!hits.length) {
    return {
      answer: "I couldn't find a direct match in the user manual. Try asking differently (for example \"create a quote\", \"set sales target\", \"apply leave\"), or chat with me about what you'd like to do in the CRM!",
      links: [],
    };
  }
  const [first, ...rest] = hits;
  let answer = `Here are the steps to do that in Team N CRM:\n\n**${first.title}**\n📍 *Menu: ${first.menuPath}*\n\n` +
    (first.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
  if (first.tips?.length) {
    answer += `\n\n💡 *Tip: ${first.tips.join(' ')}*`;
  }
  if (rest.length) {
    answer += `\n\n*Related screens:* ${rest.map((r) => r.title).join(', ')}`;
  }
  return { answer, links: hits.slice(0, 3).map(linkOf) };
}

const SYSTEM = `You are "Team N", the intelligent, friendly, and helpful AI assistant inside the Team N CRM app (a bridal makeup studio ERP & CRM).
You can converse naturally, warmly, and helpfully with users:
- Engage in friendly, natural conversation. Answer greetings, chit-chat, and polite questions naturally and warmly.
- When users ask how to do things, explain workflows, or need help with studio management (bookings, bridal quotes, trials, artist scheduling, clients, finance, leave, etc.), provide a clear, conversational explanation. Use markdown formatting (bold, bullet points) where helpful.
- Base your CRM-specific instructions, menu names, and paths strictly on the provided MANUAL ENTRIES so they match the actual app.
- Navigation links: In the "entryIds" array, return 1 to 3 IDs of manual entries ONLY when directing the user to open a specific screen in the CRM is directly relevant and helpful. When the user is having a conversation, greeting you, saying thanks, asking general studio questions, or following up without needing a screen navigation shortcut, return "entryIds": []. NEVER return irrelevant entryIds.
- You do not have direct access to private client database records (such as specific customer phone numbers or confidential financial figures). If asked for live customer data, explain how they can find it on the relevant screen.
- Reply in the same language as the question (e.g., English, or Malayalam if addressed in Malayalam).
- Output valid JSON: {"answer": string, "entryIds": string[]}.`;

export function buildPrompt(question, allowed, history = []) {
  const contextQuery = history.length
    ? `${history.slice(-2).map((h) => h.text).join(' ')} ${question}`
    : question;
  const top = rank(contextQuery, allowed, 6);
  const index = allowed.map((e) => `${e.id}: ${e.title}`).join('\n');
  const detail = top.map((e) => `[${e.id}] ${e.title} (${e.menuPath}):\n${formatEntry(e)}`).join('\n\n') || '(no close match)';
  const hist = history.slice(-6).map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${String(h.text).slice(0, 400)}`).join('\n');
  return `AVAILABLE SCREENS (id: title):\n${index}\n\nRELEVANT MANUAL ENTRIES:\n${detail}\n\n${hist ? `CONVERSATION HISTORY:\n${hist}\n\n` : ''}USER MESSAGE:\n${question}`;
}

async function askGemini(question, allowed, history) {
  const configuredModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const models = [...new Set([configuredModel, 'gemini-3.8-flash', 'gemini-1.5-flash'])];
  let lastErr = null;

  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: buildPrompt(question, allowed, history) }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 800,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: { answer: { type: 'STRING' }, entryIds: { type: 'ARRAY', items: { type: 'STRING' } } },
              required: ['answer', 'entryIds'],
            },
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini (${model}) HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed.answer !== 'string' || !parsed.answer.trim()) throw new Error('Gemini: empty answer');
      return parsed;
    } catch (e) {
      lastErr = e;
      console.warn(`[help] Model ${model} notice: ${e.message}`);
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}

const SMALL_TALK = [
  [/^(hi+|hii+|hello+|hey+|hai|namaste|namaskaram|good (morning|afternoon|evening))[\s!.]*$/i,
    "Hi! I'm Team N, your AI assistant for the CRM. How can I help you today? You can ask me how to do anything in the app, or chat with me about your studio workflows."],
  [/^(thanks?|thank you|thx|ty|nanni|ok(ay)?|great|cool|got it)[\s!.]*$/i,
    "You're very welcome! Let me know if you need anything else."],
  [/^(bye|goodbye|see you|good night)[\s!.]*$/i, 'Goodbye! Tap the Team N button anytime you need me.'],
  [/^(who are you|what are you|what can you do|help|what do you do)\s*\??$/i,
    "I'm Team N, the intelligent assistant for this CRM. I can guide you through leads, bookings, quotes, invoices, bridal trials, artist calendars, accounts, and HR. Feel free to ask me anything or chat!"],
  [/^how are you\s*\??$/i, "I'm doing great, thank you! How can I assist you with the CRM today?"],
];

export function smallTalk(question) {
  const q = String(question || '').trim();
  for (const [re, reply] of SMALL_TALK) if (re.test(q)) return reply;
  return null;
}

/// allowedIds: the entry ids the signed-in user may use (decided by the app's
/// own permission rules). Entries outside it can never be shown or linked.
export async function answer({ question, allowedIds, history = [] }) {
  const chat = smallTalk(question);
  if (chat) return { answer: chat, links: [], mode: 'local' };
  const set = new Set(allowedIds);
  const allowed = loadManual().filter((e) => set.has(e.id));
  if (process.env.GEMINI_API_KEY) {
    try {
      const out = await askGemini(question, allowed, history);
      const byId = new Map(allowed.map((e) => [e.id, e]));
      const links = (out.entryIds || []).map((id) => byId.get(id)).filter(Boolean).slice(0, 3).map(linkOf);
      return { answer: out.answer.trim(), links, mode: 'ai' };
    } catch (e) {
      console.error('[help] Gemini failed, using search fallback:', e.message);
    }
  }
  return { ...searchAnswer(question, allowed), mode: 'search' };
}
