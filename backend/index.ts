import { router, json, error, ai, auth, db, increment, requireAuth } from '@appdeploy/sdk';
import { generateWithIntelligence, getModelIntelligenceStatus } from './model-intelligence';

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type ChatImage = { data: string; mimeType: string };
type WorkspaceInput = {
  kind?: unknown;
  title?: unknown;
  detail?: unknown;
  businessName?: unknown;
};
type WorkspaceItem = {
  kind: 'business' | 'task';
  title: string;
  detail: string;
  businessName: string;
  status: string;
  createdAt: string;
};
type SupportConfig = { businessName: string; description: string; knowledge: string; updatedAt?: string };
type SupportMessage = { role: 'customer' | 'assistant'; content: string };
type SupportRecord = {
  type?: 'assistant' | 'conversation';
  businessName?: string;
  description?: string;
  knowledge?: string;
  assistantId?: string;
  messages?: SupportMessage[];
  status?: 'open' | 'needs_human' | 'resolved';
  createdAt?: string;
  updatedAt?: string;
};
const DAVIMTH_ADMIN_USER_ID = 'sZS56NuA2pZN0MUx4h4OgwwPNe13';

type RateLimitRecord = { window: number; count: number };

function hashRateKey(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function consumeRateBucket(identity: string, action: string, windowMs: number, limit: number) {
  const id = 'rl_' + hashRateKey(action + ':' + identity);
  const window = Math.floor(Date.now() / windowMs);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const [current] = await db.get<RateLimitRecord>('ai_rate_limits', [id], { consistent: true });

    if (!current) {
      const [createdId] = await db.tx.add('ai_rate_limits', [{ id, window, count: 1 }]);
      if (createdId) return limit >= 1;
      continue;
    }

    if (current.window !== window) {
      const [updated] = await db.tx.update('ai_rate_limits', [{
        id,
        record: { window, count: 1 },
        if: { window: current.window, count: current.count },
      }], { patch: true });
      if (updated) return limit >= 1;
      continue;
    }

    const nextCount = current.count + 1;
    const [updated] = await db.tx.update('ai_rate_limits', [{
      id,
      record: { count: increment(1) },
      if: { window, count: current.count },
    }], { patch: true });
    if (updated) return nextCount <= limit;
  }

  throw new Error('Rate limit counter could not be updated safely.');
}

async function enforceAiRateLimit(event: any, action: 'chat' | 'social' | 'image' | 'planner') {
  try {
    const user = await auth.getUser(event);
    const ip = event?.requestContext?.http?.sourceIp
      || event?.requestContext?.identity?.sourceIp
      || 'unknown-visitor';
    const isSignedIn = Boolean(user);
    if (user?.userId === DAVIMTH_ADMIN_USER_ID) {
      return { allowed: true, status: 200, message: 'Administrator access is unlimited.' };
    }
    const windowMs = action === 'image' ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000;
    const guestLimit = action === 'chat' ? 8 : action === 'social' ? 4 : 1;
    const userLimit = action === 'chat' ? 30 : action === 'social' ? 20 : 3;
    const ipLimit = action === 'chat' ? 40 : action === 'social' ? 25 : 5;

    if (!isSignedIn) {
      const allowed = await consumeRateBucket('guest:' + ip, action, windowMs, guestLimit);
      return {
        allowed,
        status: allowed ? 200 : 429,
        message: 'You have reached the visitor usage limit for this feature. Sign in for a higher allowance, or try again after the limit resets.',
      };
    }

    if (ip !== 'unknown-visitor') {
      const ipAllowed = await consumeRateBucket('ip:' + ip, action, windowMs, ipLimit);
      if (!ipAllowed) {
        return {
          allowed: false,
          status: 429,
          message: 'This network has reached its short-term usage limit. Please wait and try again.',
        };
      }
    }

    const userAllowed = await consumeRateBucket('user:' + user!.userId, action, windowMs, userLimit);
    return {
      allowed: userAllowed,
      status: userAllowed ? 200 : 429,
      message: 'Your account has reached its usage limit for this feature. Please wait for the limit to reset.',
    };
  } catch (err) {
    console.error('DAVImth AI usage protection failed', err);
    return {
      allowed: false,
      status: 503,
      message: 'Usage protection is temporarily unavailable. Please try again shortly.',
    };
  }
}

function supportTableFor(userId: string) {
  return 'support_' + userId.replace(/[^A-Za-z0-9_]/g, '_');
}

function studyTableFor(userId: string) {
  return 'study_sessions_' + userId.replace(/[^A-Za-z0-9_]/g, '_');
}

type StudySavedMessage = { role: 'user' | 'assistant'; content: string };
type StudySessionRecord = {
  subject: string; level: string; topic: string; messages: StudySavedMessage[];
  completed: boolean; quizAttempts: number; bestQuizPercent: number;
  userId: string; createdAt: string; updatedAt: string;
};

function tableFor(userId: string) {
  const safeUser = userId.replace(/[^A-Za-z0-9_]/g, '_');
  return 'workspace_' + safeUser;
}

type AutonomyQueueItem = {
  id: string; userId: string; goalId: string; taskId: string; taskTitle: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: string; startedAt?: string; finishedAt?: string;
};

export const autonomyQueueWorker = async (_event: {
  type: 'cron'; name: string; invocationId: string; scheduledTime: string; invokedTime: string;
}) => {
  try {
    const page = await db.list<AutonomyQueueItem>('autonomy_run_queue', { limit: 50 });
    const item = page.items.filter(run => run.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!item) return { statusCode: 200 };

    const startedAt = new Date().toISOString();
    const [claimed] = await db.tx.update('autonomy_run_queue', [{
      id: item.id, record: { status: 'running', startedAt }, if: { status: 'queued' },
    }], { patch: true });
    if (!claimed) return { statusCode: 200 };

    const table = 'autonomy_' + item.userId.replace(/[^A-Za-z0-9_]/g, '_');
    const [goal] = await db.get<{
      title: string; context: string;
      tasks: Array<{ id: string; title: string; detail: string; successCriteria: string; status: string; preparation?: { runId: string } }>;
    }>(table, [item.goalId], { consistent: true });
    const task = goal?.tasks?.find(entry => entry.id === item.taskId);
    if (!goal || !task || task.status !== 'queued' || task.preparation?.runId !== item.id) {
      await db.tx.update('autonomy_run_queue', [{ id: item.id, record: { status: 'failed', finishedAt: new Date().toISOString() }, if: { status: 'running' } }], { patch: true });
      return { statusCode: 200 };
    }

    const runningTasks = goal.tasks.map(entry => entry.id === item.taskId
      ? { ...entry, status: 'preparing', preparation: { runId: item.id, status: 'running', startedAt, finishedAt: startedAt } }
      : entry);
    const [started] = await db.tx.update(table, [{ id: item.goalId, record: { tasks: runningTasks }, if: { tasks: goal.tasks } }], { patch: true });
    if (!started) {
      await db.tx.update('autonomy_run_queue', [{ id: item.id, record: { status: 'failed', finishedAt: new Date().toISOString() }, if: { status: 'running' } }], { patch: true });
      return { statusCode: 200 };
    }

    try {
      const response = await generateWithIntelligence('autonomy', {
        system: 'You are DAVImth Safe Background Preparation Worker. Create an internal work package only. Never execute tasks, browse, call tools, write or run code, contact people, publish, spend money, access accounts or change external data. Never claim completion.',
        prompt: 'Prepare an internal work package. Goal: ' + goal.title + '\nBoundaries: ' + (goal.context || 'None supplied.')
          + '\nTask: ' + task.title + '\nDetails: ' + task.detail + '\nSuccess: ' + task.successCriteria
          + '\nReturn an objective, 3 to 7 checklist items, a deliverable outline and up to 4 risks. Do not perform the task.',
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            objective: { type: 'string' },
            checklist: { type: 'array', minItems: 3, maxItems: 7, items: { type: 'string' } },
            deliverable: { type: 'string' },
            risks: { type: 'array', maxItems: 4, items: { type: 'string' } },
          },
          required: ['objective', 'checklist', 'deliverable', 'risks'],
        },
        maxTokens: 900, temperature: 0.2, thinkingMode: 'DEEP',
      });
      const output = JSON.parse(response.text) as { objective?: unknown; checklist?: unknown; deliverable?: unknown; risks?: unknown };
      if (typeof output.objective !== 'string' || !Array.isArray(output.checklist)
        || output.checklist.length < 3 || output.checklist.length > 7
        || !output.checklist.every(value => typeof value === 'string')
        || typeof output.deliverable !== 'string' || !Array.isArray(output.risks)
        || output.risks.length > 4 || !output.risks.every(value => typeof value === 'string')) {
        throw new Error('Invalid preparation output.');
      }

      const [latestRun] = await db.get<AutonomyQueueItem>('autonomy_run_queue', [item.id], { consistent: true });
      const [latestGoal] = await db.get<typeof goal>(table, [item.goalId], { consistent: true });
      if (!latestGoal?.tasks) throw new Error('Goal could not be reloaded.');
      const latestTask = latestGoal.tasks.find(entry => entry.id === item.taskId);
      if (latestRun?.status === 'cancelled') {
        if (latestTask?.preparation?.runId === item.id) {
          const cancelledTasks = latestGoal.tasks.map(entry => entry.id === item.taskId
            ? { ...entry, status: 'cancelled', preparation: { ...entry.preparation, status: 'cancelled', finishedAt: new Date().toISOString() } }
            : entry);
          await db.tx.update(table, [{ id: item.goalId, record: { tasks: cancelledTasks }, if: { tasks: latestGoal.tasks } }], { patch: true });
        }
        return { statusCode: 200 };
      }
      if (latestRun?.status !== 'running' || latestTask?.status !== 'preparing' || latestTask.preparation?.runId !== item.id) return { statusCode: 200 };

      const finishedAt = new Date().toISOString();
      const preparedTasks = latestGoal.tasks.map(entry => entry.id === item.taskId ? {
        ...entry, status: 'prepared',
        preparation: {
          runId: item.id, status: 'prepared', startedAt, finishedAt,
          objective: output.objective as string,
          checklist: (output.checklist as string[]).map(value => value.slice(0, 240)),
          deliverable: (output.deliverable as string).slice(0, 500),
          risks: (output.risks as string[]).map(value => value.slice(0, 240)),
        },
      } : entry);
      const [saved] = await db.tx.update(table, [{ id: item.goalId, record: { tasks: preparedTasks }, if: { tasks: latestGoal.tasks } }], { patch: true });
      if (saved) await db.tx.update('autonomy_run_queue', [{ id: item.id, record: { status: 'succeeded', finishedAt }, if: { status: 'running' } }], { patch: true });
    } catch (err) {
      console.error('DAVImth background preparation failed', err);
      const finishedAt = new Date().toISOString();
      const [latestRun] = await db.get<AutonomyQueueItem>('autonomy_run_queue', [item.id], { consistent: true });
      if (latestRun?.status !== 'cancelled') {
        await db.tx.update('autonomy_run_queue', [{ id: item.id, record: { status: 'failed', finishedAt }, if: { status: 'running' } }], { patch: true });
        const [latestGoal] = await db.get<{ tasks: Array<{ id: string; preparation?: { runId: string } }> }>(table, [item.goalId], { consistent: true });
        if (latestGoal?.tasks) {
          const failedTasks = latestGoal.tasks.map(entry => entry.id === item.taskId && entry.preparation?.runId === item.id
            ? { ...entry, status: 'preparation_failed', preparation: { ...entry.preparation, status: 'preparation_failed', finishedAt, error: 'Background preparation failed. Review and retry.' } }
            : entry);
          await db.update(table, [{ id: item.goalId, record: { tasks: failedTasks } }]);
        }
      }
    }
  } catch (err) {
    console.error('DAVImth queue worker failed', err);
  }
  return { statusCode: 200 };
};

export const handler = router({

  'GET /api/intelligence/status': [
    async () => json(getModelIntelligenceStatus()),
  ],

  'GET /api/study/access': [
    requireAuth(),
    async ({ user }) => json({ isAdmin: user!.userId === DAVIMTH_ADMIN_USER_ID, premiumUnlocked: user!.userId === DAVIMTH_ADMIN_USER_ID }),
  ],
  'POST /api/study/tutor': [
    requireAuth(),
    async ({ user, body }) => {
      if (!body || typeof body !== 'object') return error('Study details are required.', 400);
      const input = body as { subject?: unknown; level?: unknown; topic?: unknown; messages?: unknown; images?: unknown; audios?: unknown };
      if (typeof input.subject !== 'string' || input.subject.length > 80 || typeof input.level !== 'string' || input.level.length > 60) return error('Choose a valid subject and learning level.', 400);
      if (input.topic !== undefined && (typeof input.topic !== 'string' || input.topic.length > 120)) return error('Choose a topic of up to 120 characters.', 400);
      if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 12) return error('Send between 1 and 12 study messages.', 400);
      const messages: ChatMessage[] = [];
      for (const item of input.messages) {
        if (!item || typeof item !== 'object' || !('role' in item) || !('content' in item)) return error('A study message is invalid.', 400);
        const candidate = item as { role: unknown; content: unknown };
        if ((candidate.role !== 'user' && candidate.role !== 'assistant') || typeof candidate.content !== 'string' || !candidate.content.trim() || candidate.content.length > 16000) return error('A study message has invalid content.', 400);
        messages.push({ role: candidate.role, content: candidate.content.trim() });
      }
      if (messages[messages.length - 1].role !== 'user') return error('The latest study message must come from the student.', 400);
      const images: ChatImage[] = [];
      if (input.images !== undefined) {
        if (!Array.isArray(input.images) || input.images.length > 5) return error('Attach up to five images.', 400);
        for (const item of input.images) {
          if (!item || typeof item !== 'object' || !('data' in item) || !('mimeType' in item)) return error('An image attachment is invalid.', 400);
          const candidate = item as { data: unknown; mimeType: unknown };
          if (typeof candidate.data !== 'string' || candidate.data.length > 8_000_000 || typeof candidate.mimeType !== 'string' || !['image/jpeg','image/png','image/webp'].includes(candidate.mimeType)) return error('Images must be JPEG, PNG or WebP and within the size limit.', 400);
          images.push({ data: candidate.data, mimeType: candidate.mimeType });
        }
      }
      const audios: Array<{ data: string; mimeType: string }> = [];
      if (input.audios !== undefined) {
        if (!Array.isArray(input.audios) || input.audios.length > 3) return error('Attach up to three voice recordings.', 400);
        for (const item of input.audios) {
          if (!item || typeof item !== 'object' || !('data' in item) || !('mimeType' in item)) return error('A voice recording is invalid.', 400);
          const candidate = item as { data: unknown; mimeType: unknown };
          if (typeof candidate.data !== 'string' || candidate.data.length > 2_800_000 || typeof candidate.mimeType !== 'string' || !['audio/webm','audio/mpeg','audio/wav','audio/mp4','audio/ogg'].includes(candidate.mimeType)) return error('Voice recordings must use a supported audio format and be 2 MB or smaller.', 400);
          audios.push({ data: candidate.data, mimeType: candidate.mimeType });
        }
      }
      const isAdmin = user!.userId === DAVIMTH_ADMIN_USER_ID;
      try {
        const result = await generateWithIntelligence('education', {
          system: 'You are DAVImth AI Study Buddy, a kind, patient and encouraging human-style tutor. Teach the student in simple language at the selected level. Subject: ' + input.subject + '. Level: ' + input.level + '. Topic: ' + String(input.topic || 'General introduction').slice(0, 120) + '. Start from the basics when requested. Break explanations into small steps, use relatable real-life examples, and never shame the student. Ask only ONE question at a time and wait for the student to answer before continuing. When the student is wrong, explain gently and give another chance. Help with assignments by teaching, brainstorming and giving feedback rather than secretly completing assessed work for them. When discussing uploaded material, stay grounded in what is readable and say when something cannot be seen or heard. The student account has administrator status: ' + (isAdmin ? 'yes; all DAVImth Study Buddy and premium application features are unlocked without a subscription charge.' : 'no; use the standard student experience.') ,
          messages,
          images: images.length ? images : undefined,
          audios: audios.length ? audios : undefined,
          maxTokens: 900,
          temperature: 0.55,
          thinkingMode: 'DEEP',
        });
        return json({ reply: result.text, isAdmin });
      } catch (err) {
        console.error('DAVImth Study Buddy tutor failed', err);
        const rpcError = err as { statusCode?: number; responseText?: string };
        const failureText = String(rpcError?.responseText || err).toLowerCase();
        if (rpcError?.statusCode === 429 || failureText.includes('ai_usage_limit_exceeded') || failureText.includes('daily')) {
          return error('The shared AI service has reached its current usage limit. Your study materials are safe; please try the tutor again later.', 429);
        }
        return error('Your Study Buddy is temporarily unavailable. Please try again.', 500);
      }
    },
  ],
  'GET /api/study/sessions': [
    requireAuth(),
    async ({ user }) => {
      const page = await db.list<StudySessionRecord>(studyTableFor(user!.userId), { limit: 30 });
      const sessions = page.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(item => ({
        id: item.id, subject: item.subject, level: item.level, topic: item.topic,
        messages: item.messages, completed: item.completed, quizAttempts: item.quizAttempts,
        bestQuizPercent: item.bestQuizPercent, createdAt: item.createdAt, updatedAt: item.updatedAt,
      }));
      return json({ sessions, summary: {
        completedLessons: sessions.filter(item => item.completed).length,
        quizAttempts: sessions.reduce((sum, item) => sum + item.quizAttempts, 0),
        bestQuizPercent: sessions.reduce((best, item) => Math.max(best, item.bestQuizPercent), 0),
      } });
    },
  ],
  'POST /api/study/sessions': [
    requireAuth(),
    async ({ user, body }) => {
      if (!body || typeof body !== 'object') return error('A study session is required.', 400);
      const input = body as { sessionId?: unknown; subject?: unknown; level?: unknown; topic?: unknown; messages?: unknown; completed?: unknown; quizAttempts?: unknown; bestQuizPercent?: unknown };
      if (typeof input.sessionId !== 'string' || !/^study-[A-Za-z0-9_-]{8,80}$/.test(input.sessionId)) return error('The study session ID is invalid.', 400);
      if (typeof input.subject !== 'string' || input.subject.length > 80 || typeof input.level !== 'string' || input.level.length > 60 || typeof input.topic !== 'string' || input.topic.length > 120) return error('Choose a valid subject, level and topic.', 400);
      if (!Array.isArray(input.messages) || input.messages.length > 12) return error('A saved lesson can contain up to 12 recent messages.', 400);
      const messages: StudySavedMessage[] = [];
      for (const item of input.messages) {
        if (!item || typeof item !== 'object' || !('role' in item) || !('content' in item)) return error('A saved lesson message is invalid.', 400);
        const message = item as { role: unknown; content: unknown };
        if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' || message.content.length > 16000) return error('A saved lesson message has invalid content.', 400);
        messages.push({ role: message.role, content: message.content });
      }
      if (input.completed !== undefined && typeof input.completed !== 'boolean') return error('Lesson completion must be true or false.', 400);
      const quizAttempts = input.quizAttempts === undefined ? 0 : Number(input.quizAttempts);
      const bestQuizPercent = input.bestQuizPercent === undefined ? 0 : Number(input.bestQuizPercent);
      if (!Number.isInteger(quizAttempts) || quizAttempts < 0 || quizAttempts > 10000 || !Number.isFinite(bestQuizPercent) || bestQuizPercent < 0 || bestQuizPercent > 100) return error('The saved quiz progress is invalid.', 400);
      const table = studyTableFor(user!.userId);
      const [existing] = await db.get<StudySessionRecord>(table, [input.sessionId], { consistent: true });
      const now = new Date().toISOString();
      const record: StudySessionRecord = {
        userId: user!.userId, subject: input.subject.trim(), level: input.level.trim(), topic: input.topic.trim(),
        messages, completed: input.completed === true || existing?.completed === true,
        quizAttempts: Math.max(quizAttempts, existing?.quizAttempts || 0),
        bestQuizPercent: Math.max(bestQuizPercent, existing?.bestQuizPercent || 0),
        createdAt: existing?.createdAt || now, updatedAt: now,
      };
      const [created] = await db.tx.add(table, [{ id: input.sessionId, ...record }]);
      if (!created) {
        const [updated] = await db.tx.update(table, [{ id: input.sessionId, record, if: { userId: user!.userId } }], { patch: true });
        if (!updated) return error('This saved lesson could not be updated. Refresh and try again.', 409);
      }
      return json({ session: { id: input.sessionId, ...record } });
    },
  ],
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],
  'GET /api/ai/providers/status': [async () => json(await getModelIntelligenceStatus())],
  'POST /api/chat': [
    async ({ body, event }) => {
      const rate = await enforceAiRateLimit(event, 'chat');
      if (!rate.allowed) return error(rate.message, rate.status);
      if (!body || typeof body !== 'object' || !('messages' in body)) return error('A messages array is required.', 400);
      const requestBody = body as { messages?: unknown; images?: unknown };
      const rawMessages = requestBody.messages;
      const rawImages = requestBody.images;
      if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > 12) return error('Send between 1 and 12 conversation messages.', 400);
      const messages: ChatMessage[] = [];
      for (const item of rawMessages) {
        if (!item || typeof item !== 'object' || !('role' in item) || !('content' in item)) return error('Each message must include a role and content.', 400);
        const candidate = item as { role: unknown; content: unknown };
        if ((candidate.role !== 'user' && candidate.role !== 'assistant') || typeof candidate.content !== 'string' || candidate.content.trim().length === 0 || candidate.content.length > 16000) return error('A message has invalid content or role.', 400);
        messages.push({ role: candidate.role, content: candidate.content.trim() });
      }
      if (messages[messages.length - 1].role !== 'user') return error('The latest message must come from the user.', 400);
      const images: ChatImage[] = [];
      if (rawImages !== undefined) {
        if (!Array.isArray(rawImages) || rawImages.length > 5) return error('Attach up to five images per message.', 400);
        for (const item of rawImages) {
          if (!item || typeof item !== 'object' || !('data' in item) || !('mimeType' in item)) return error('An image attachment is invalid.', 400);
          const candidate = item as { data: unknown; mimeType: unknown };
          if (typeof candidate.data !== 'string' || candidate.data.length > 8_000_000 || typeof candidate.mimeType !== 'string' || !['image/jpeg', 'image/png', 'image/webp'].includes(candidate.mimeType)) return error('Images must be JPEG, PNG or WebP and within the size limit.', 400);
          images.push({ data: candidate.data, mimeType: candidate.mimeType });
        }
      }
      try {
        const result = await generateWithIntelligence('general', {
          system: 'You are DAVImth, a high-capability, globally minded AI assistant. Use careful multi-step reasoning internally for complex tasks. First understand the user intent and constraints; identify missing information and ask only when necessary. Break difficult problems into logical steps, compare viable approaches, check calculations and consistency, and review your answer for errors before responding. Give direct, practical, well-structured answers at the user\'s level. Be creative without inventing facts. Clearly distinguish verified facts, assumptions, estimates and uncertainty. Never claim to have browsed, executed code, changed an account or completed an external action unless a tool actually confirms it. Respect privacy, safety, law and user permissions. For high-impact decisions, explain important risks and encourage appropriate verification.',
          messages, images: images.length ? images : undefined, maxTokens: 1500, temperature: 0.55, thinkingMode: 'DEEP',
        });
        return json({ reply: result.text });
      } catch (err) {
        console.error('DAVImth AI generation failed', err);
        const rpcError = err as { statusCode?: number; responseText?: string };
        const failureText = String(rpcError?.responseText || err).toLowerCase();
        if (rpcError?.statusCode === 429 || failureText.includes('ai_usage_limit_exceeded') || failureText.includes('daily')) {
          return error('DAVImth AI has reached the shared AI service usage limit for now. Your conversation is still here; please try again later.', 429);
        }
        return error('DAVImth is temporarily unable to respond. Please try again.', 500);
      }
    },
  ],
  'POST /api/social-assist': [
    async ({ body, event }) => {
      const rate = await enforceAiRateLimit(event, 'social');
      if (!rate.allowed) return error(rate.message, rate.status);
      if (!body || typeof body !== 'object') return error('A content brief is required.', 400);
      const input = body as { action?: unknown; platform?: unknown; brief?: unknown; caption?: unknown };
      const actions = ['caption', 'hashtags', 'format', 'video-plan'];
      if (typeof input.action !== 'string' || !actions.includes(input.action)) return error('Choose a supported content action.', 400);
      if (typeof input.platform !== 'string' || input.platform.length > 60) return error('Choose a social platform.', 400);
      if (typeof input.brief !== 'string' || input.brief.trim().length < 3 || input.brief.length > 3000) return error('Enter a campaign brief between 3 and 3000 characters.', 400);
      const actionInstructions: Record<string, string> = {
        caption: 'Write one engaging, natural social media caption with a clear hook and call to action. Do not invent prices, claims or contact details.',
        hashtags: 'Suggest 8 to 15 relevant, non-spammy hashtags. Return hashtags only, separated by spaces.',
        format: 'Rewrite the supplied caption for the selected social platform. Respect its usual audience and format. Return only the improved post text.',
        'video-plan': 'Create a practical short-form promotional video script and storyboard with a hook, 4 to 6 scenes, visual direction, on-screen text, voiceover, and closing call to action. This is a written plan, not a rendered video.',
      };
      try {
        const result = await generateWithIntelligence('growth', {
          system: 'You are DAVImth Growth, a responsible global social media strategist. Be original, useful and concise. Never fabricate product facts, testimonials, discounts, statistics or guarantees. Avoid deceptive engagement tactics.',
          prompt: actionInstructions[input.action] + '\nPlatform: ' + input.platform + '\nCampaign brief: ' + input.brief.trim() + '\nExisting caption: ' + (typeof input.caption === 'string' ? input.caption.slice(0, 5000) : 'None'),
          maxTokens: input.action === 'video-plan' ? 1200 : 500,
          temperature: 0.7,
          thinkingMode: 'DEEP',
        });
        return json({ text: result.text });
      } catch (err) {
        console.error('DAVImth social content generation failed', err);
        return error('AI content generation is temporarily unavailable. Please try again.', 500);
      }
    },
  ],
  'POST /api/generate-image': [
    async ({ body, event }) => {
      const rate = await enforceAiRateLimit(event, 'image');
      if (!rate.allowed) return error(rate.message, rate.status);
      if (!body || typeof body !== 'object' || !('prompt' in body)) return error('An image prompt is required.', 400);
      const prompt = (body as { prompt?: unknown }).prompt;
      if (typeof prompt !== 'string' || prompt.trim().length < 5 || prompt.length > 1200) return error('Enter an image description between 5 and 1200 characters.', 400);
      try {
        const result = await ai.imageGen({ prompt: `Create a high-quality, visually coherent image. Follow this user brief: ${prompt.trim()}`, maxOutputBytes: 1000000 });
        return json({ imageData: result.image.data, mimeType: result.image.mimeType });
      } catch (err) {
        console.error('DAVImth image generation failed', err);
        const rpcError = err as { statusCode?: number; responseText?: string };
        const failureText = String(rpcError?.responseText || err).toLowerCase();
        if (rpcError?.statusCode === 429 || failureText.includes('ai_usage_limit_exceeded') || failureText.includes('daily')) {
          return error('The free image service has reached its shared daily limit. It resets at 1:00 a.m. Nigeria time. Please try again after then.', 429);
        }
        return error('Image generation is temporarily unavailable. Please try again later.', 500);
      }
    },
  ],
  'GET /api/support/assistants': [
    requireAuth(),
    async ({ user }) => {
      const table = supportTableFor(user!.userId);
      const result = await db.list<SupportRecord>(table, { limit: 100 });
      const assistants = result.items
        .filter(item => item.type === 'assistant' || item.id === 'settings')
        .map(item => ({
          id: item.id,
          businessName: item.businessName || '',
          description: item.description || '',
          knowledge: item.knowledge || '',
          createdAt: item.createdAt || '',
          updatedAt: item.updatedAt || '',
        }))
        .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
      return json({ assistants });
    },
  ],
  'POST /api/support/assistants': [
    requireAuth(),
    async ({ user, body }) => {
      if (!body || typeof body !== 'object') return error('Assistant details are required.', 400);
      const input = body as { businessName?: unknown; description?: unknown; knowledge?: unknown };
      if (typeof input.businessName !== 'string' || input.businessName.trim().length < 2 || input.businessName.length > 100) return error('Enter a business name between 2 and 100 characters.', 400);
      if (typeof input.description !== 'string' || input.description.trim().length < 10 || input.description.length > 1500) return error('Enter a business description between 10 and 1500 characters.', 400);
      if (typeof input.knowledge !== 'string' || input.knowledge.length > 12000) return error('FAQs and policies must be 12000 characters or fewer.', 400);
      const now = new Date().toISOString();
      const assistant = {
        type: 'assistant' as const,
        businessName: input.businessName.trim(),
        description: input.description.trim(),
        knowledge: input.knowledge.trim(),
        createdAt: now,
        updatedAt: now,
      };
      const [id] = await db.add(supportTableFor(user!.userId), [assistant]);
      if (!id) return error('The assistant could not be created. Please try again.', 500);
      return json({ assistant: { id, ...assistant } }, 201);
    },
  ],
  'PUT /api/support/assistants/:assistantId': [
    requireAuth(),
    async ({ user, params, body }) => {
      if (!body || typeof body !== 'object') return error('Assistant details are required.', 400);
      const input = body as { businessName?: unknown; description?: unknown; knowledge?: unknown };
      if (typeof input.businessName !== 'string' || input.businessName.trim().length < 2 || input.businessName.length > 100) return error('Enter a business name between 2 and 100 characters.', 400);
      if (typeof input.description !== 'string' || input.description.trim().length < 10 || input.description.length > 1500) return error('Enter a business description between 10 and 1500 characters.', 400);
      if (typeof input.knowledge !== 'string' || input.knowledge.length > 12000) return error('FAQs and policies must be 12000 characters or fewer.', 400);
      const table = supportTableFor(user!.userId);
      const [existing] = await db.get<SupportRecord>(table, [params.assistantId], { consistent: true });
      if (!existing || (existing.type !== 'assistant' && params.assistantId !== 'settings')) return error('Assistant not found.', 404);
      const updatedRecord = {
        ...existing,
        type: 'assistant' as const,
        businessName: input.businessName.trim(),
        description: input.description.trim(),
        knowledge: input.knowledge.trim(),
        updatedAt: new Date().toISOString(),
      };
      const [updated] = await db.update(table, [{ id: params.assistantId, record: updatedRecord }]);
      if (!updated) return error('The assistant could not be updated. Please try again.', 500);
      return json({ saved: true, assistant: { id: params.assistantId, ...updatedRecord } });
    },
  ],
  'GET /api/support/assistants/:assistantId/conversations': [
    requireAuth(),
    async ({ user, params }) => {
      const table = supportTableFor(user!.userId);
      const result = await db.list<SupportRecord>(table, { limit: 100 });
      const conversations = result.items
        .filter(item => item.type === 'conversation' && item.assistantId === params.assistantId)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return json({ conversations });
    },
  ],
  'POST /api/support/assistants/:assistantId/chat': [
    requireAuth(),
    async ({ user, params, body }) => {
      if (!body || typeof body !== 'object' || !('message' in body)) return error('A customer message is required.', 400);
      const input = body as { message?: unknown; conversationId?: unknown };
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 3000) return error('Enter a message up to 3000 characters.', 400);
      if (input.conversationId !== undefined && (typeof input.conversationId !== 'string' || input.conversationId.length > 128)) return error('The conversation reference is invalid.', 400);
      const table = supportTableFor(user!.userId);
      const [assistant] = await db.get<SupportRecord>(table, [params.assistantId], { consistent: true });
      if (!assistant || (assistant.type !== 'assistant' && params.assistantId !== 'settings')) return error('Assistant not found.', 404);
      if (!assistant.businessName || !assistant.description) return error('Complete and save this assistant profile before testing it.', 409);
      let conversation: SupportRecord | null = null;
      let conversationId = typeof input.conversationId === 'string' ? input.conversationId : '';
      if (conversationId) {
        const [saved] = await db.get<SupportRecord>(table, [conversationId], { consistent: true });
        if (!saved || saved.type !== 'conversation' || saved.assistantId !== params.assistantId) return error('Conversation not found for this assistant.', 404);
        conversation = saved;
      }
      const history = conversation?.messages || [];
      const modelMessages = history.slice(-10).map(item => ({
        role: item.role === 'customer' ? 'user' as const : 'assistant' as const,
        content: item.content,
      }));
      modelMessages.push({ role: 'user', content: input.message.trim() });
      try {
        const result = await generateWithIntelligence('business', {
          system: 'You are the customer support assistant for ' + assistant.businessName + '. Business description: ' + assistant.description + '. Use the supplied business knowledge as the authority for what this business offers, its prices, opening hours, availability and policies. Be warm, professional, concise and helpful. You may also explain high-level general public information when useful, clearly labeling it as general guidance rather than a confirmed business policy. For Nigerian CAC registration questions, explain only the broad usual stages: choose the business structure, check or reserve a name, complete the relevant application on the official CAC portal, provide the particulars requested for that entity type, pay the current official fees, and wait for CAC review and approval before obtaining the registration documents. Explain that business-name and company registration have different requirements. Do not provide fixed fees, guaranteed timelines, exhaustive document checklists or promises of approval; requirements and fees can change, so direct customers to the current official CAC portal or a human representative for confirmation. Ask which entity type they intend to register if that affects the answer. Never claim this business provides a service unless its profile says so. Never invent prices, availability, delivery dates, refund promises, policies or order status. If a business-specific answer is not supplied, say you cannot confirm that detail and offer a human agent. For complaints, payment disputes, account security, personal data requests or urgent matters, recommend a human agent. Never ask for passwords, one-time codes or full payment-card details.\n\nBusiness knowledge and FAQs:\n' + (assistant.knowledge || 'No additional FAQs or policies have been supplied yet.'),
          messages: modelMessages,
          maxTokens: 600,
          temperature: 0.3,
          thinkingMode: 'DEEP',
        });
        const reply = result.text.trim();
        const needsHuman = /(speak to (a )?human|human agent|talk to (a )?person|real person|manager|payment dispute|account security|complaint)/i.test(input.message) || /(cannot confirm|human agent|speak to a person|contact a human)/i.test(reply);
        const now = new Date().toISOString();
        const nextMessages: SupportMessage[] = [
          ...history,
          { role: 'customer', content: input.message.trim() },
          { role: 'assistant', content: reply },
        ].slice(-30);
        const record = {
          type: 'conversation' as const,
          assistantId: params.assistantId,
          messages: nextMessages,
          status: needsHuman ? 'needs_human' as const : conversation?.status === 'resolved' ? 'open' as const : conversation?.status || 'open' as const,
          createdAt: conversation?.createdAt || now,
          updatedAt: now,
        };
        if (conversationId) {
          const [updated] = await db.update(table, [{ id: conversationId, record }]);
          if (!updated) return error('The conversation could not be saved. Please try again.', 500);
        } else {
          const [createdId] = await db.add(table, [record]);
          if (!createdId) return error('The conversation could not be saved. Please try again.', 500);
          conversationId = createdId;
        }
        return json({ reply, conversationId, needsHuman, status: record.status });
      } catch (err) {
        console.error('DAVImth customer support response failed', err);
        return error('The AI support assistant is temporarily unavailable. Please offer the customer a human contact option.', 500);
      }
    },
  ],
  'POST /api/support/assistants/:assistantId/conversations/:conversationId/handover': [
    requireAuth(),
    async ({ user, params, body }) => {
      const status = body && typeof body === 'object' && 'status' in body ? (body as { status?: unknown }).status : 'needs_human';
      if (status !== 'open' && status !== 'needs_human' && status !== 'resolved') return error('Choose a valid conversation status.', 400);
      const table = supportTableFor(user!.userId);
      const [existing] = await db.get<SupportRecord>(table, [params.conversationId], { consistent: true });
      if (!existing || existing.type !== 'conversation' || existing.assistantId !== params.assistantId) return error('Conversation not found for this assistant.', 404);
      const updatedRecord = { ...existing, status, updatedAt: new Date().toISOString() };
      const [updated] = await db.update(table, [{ id: params.conversationId, record: updatedRecord }]);
      if (!updated) return error('The conversation status could not be updated.', 500);
      return json({ updated: true, status });
    },
  ],
  'GET /api/support/config': [
    requireAuth(),
    async ({ user }) => {
      const table = 'support_' + user!.userId.replace(/[^A-Za-z0-9_]/g, '_');
      const [saved] = await db.get<SupportConfig>(table, ['settings']);
      return json({ config: saved || { businessName: '', description: '', knowledge: '' } });
    },
  ],
  'PUT /api/support/config': [
    requireAuth(),
    async ({ user, body }) => {
      if (!body || typeof body !== 'object') return error('Support settings are required.', 400);
      const input = body as { businessName?: unknown; description?: unknown; knowledge?: unknown };
      if (typeof input.businessName !== 'string' || input.businessName.trim().length < 2 || input.businessName.length > 100) return error('Enter a business name between 2 and 100 characters.', 400);
      if (typeof input.description !== 'string' || input.description.trim().length < 10 || input.description.length > 1500) return error('Enter a business description between 10 and 1500 characters.', 400);
      if (typeof input.knowledge !== 'string' || input.knowledge.length > 12000) return error('Business FAQs and policies must be 12000 characters or fewer.', 400);
      const table = 'support_' + user!.userId.replace(/[^A-Za-z0-9_]/g, '_');
      const config: SupportConfig = { businessName: input.businessName.trim(), description: input.description.trim(), knowledge: input.knowledge.trim(), updatedAt: new Date().toISOString() };
      const [existing] = await db.get<SupportConfig>(table, ['settings'], { consistent: true });
      if (existing) {
        const [updated] = await db.update(table, [{ id: 'settings', record: config }]);
        if (!updated) return error('Support settings could not be updated. Please try again.', 500);
      } else {
        const [created] = await db.add(table, [{ id: 'settings', ...config }]);
        if (!created) return error('Support settings could not be saved. Please try again.', 500);
      }
      return json({ saved: true, config });
    },
  ],
  'POST /api/support/chat': [
    requireAuth(),
    async ({ user, body }) => {
      if (!body || typeof body !== 'object' || !('message' in body)) return error('A customer message is required.', 400);
      const message = (body as { message?: unknown }).message;
      if (typeof message !== 'string' || message.trim().length < 1 || message.length > 3000) return error('Enter a message up to 3000 characters.', 400);
      const table = 'support_' + user!.userId.replace(/[^A-Za-z0-9_]/g, '_');
      const [config] = await db.get<SupportConfig>(table, ['settings']);
      if (!config?.businessName || !config.description) return error('Set up and save your business support profile before testing the assistant.', 409);
      try {
        const result = await generateWithIntelligence('business', {
          system: 'You are the customer support assistant for ' + config.businessName + '. Business description: ' + config.description + '. Use only the business information supplied below. Be warm, professional, concise and helpful. Never invent prices, availability, delivery dates, refund promises, policies or order status. If the answer is not in the supplied information, say you cannot confirm it and offer a human handover. For complaints, payment disputes, account security, personal data requests or urgent matters, recommend a human agent. Never ask customers for passwords, one-time codes or full payment-card details.\n\nBusiness knowledge and FAQs:\n' + (config.knowledge || 'No additional FAQs or policies have been supplied yet.'),
          prompt: message.trim(),
          maxTokens: 600,
          temperature: 0.3,
          thinkingMode: 'DEEP',
        });
        return json({ reply: result.text });
      } catch (err) {
        console.error('DAVImth customer support response failed', err);
        return error('The AI support assistant is temporarily unavailable. Please offer the customer a human contact option.', 500);
      }
    },
  ],
  'GET /api/autonomy/goals': [
    requireAuth(),
    async ({ user }) => {
      const table = 'autonomy_' + user!.userId.replace(/[^A-Za-z0-9_]/g, '_');
      const result = await db.list<{
        title: string;
        context: string;
        summary: string;
        tasks: Array<{ id: string; title: string; detail: string; successCriteria: string; status: 'awaiting_approval' | 'approved' | 'rejected' | 'queued' | 'preparing' | 'prepared' | 'preparation_failed' | 'cancelled'; preparation?: { runId: string; status: 'queued' | 'running' | 'prepared' | 'preparation_failed' | 'cancelled'; startedAt: string; finishedAt: string; objective?: string; checklist?: string[]; deliverable?: string; risks?: string[]; error?: string } }>;
        createdAt: string;
      }>(table, { limit: 30 });
      const goals = result.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({ goals });
    },
  ],
  'POST /api/autonomy/plan': [
    requireAuth(),
    async ({ user, body, event }) => {
      const rate = await enforceAiRateLimit(event, 'planner');
      if (!rate.allowed) return error(rate.message, rate.status);
      if (!body || typeof body !== 'object') return error('A goal description is required.', 400);
      const input = body as { title?: unknown; context?: unknown };
      if (typeof input.title !== 'string' || input.title.trim().length < 4 || input.title.length > 140) return error('Enter a goal between 4 and 140 characters.', 400);
      if (input.context !== undefined && (typeof input.context !== 'string' || input.context.length > 1800)) return error('Extra details must be 1800 characters or fewer.', 400);
      const goalTitle = input.title.trim();
      const goalContext = typeof input.context === 'string' ? input.context.trim() : '';
      try {
        const result = await generateWithIntelligence('autonomy', {
          system: 'You are DAVImth Autonomous Intelligence, a careful goal-planning engine. Break the user goal into 3 to 8 practical, ordered tasks. Make tasks specific, achievable and verifiable. Respect the user\'s stated limits. Do not assume access to accounts, credentials, money, external services or private data. Never treat this planning request as permission to execute anything. Do not propose sending messages, publishing, spending money, deleting data, changing accounts or other external/irreversible actions without clearly marking them as requiring separate explicit approval. Return only the requested structured plan.',
          prompt: 'Create a practical plan for this goal. Goal: ' + goalTitle + '\nAdditional context and boundaries: ' + (goalContext || 'No additional context supplied.') + '\nEach task must have a short title, a clear description and a measurable success criterion.',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string' },
              tasks: {
                type: 'array',
                minItems: 3,
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    detail: { type: 'string' },
                    successCriteria: { type: 'string' },
                  },
                  required: ['title', 'detail', 'successCriteria'],
                },
              },
            },
            required: ['summary', 'tasks'],
          },
          maxTokens: 2200,
          temperature: 0.25,
          thinkingMode: 'DEEP',
        });
        const plan = JSON.parse(result.text) as {
          summary?: unknown;
          tasks?: Array<{ title?: unknown; detail?: unknown; successCriteria?: unknown }>;
        };
        if (typeof plan.summary !== 'string' || !Array.isArray(plan.tasks) || plan.tasks.length < 3 || plan.tasks.length > 8) {
          return error('The AI planner returned an incomplete plan. Please try again.', 502);
        }
        const tasks = plan.tasks.map((task, index) => {
          if (typeof task.title !== 'string' || typeof task.detail !== 'string' || typeof task.successCriteria !== 'string') {
            throw new Error('Invalid task structure');
          }
          return {
            id: 'task-' + (index + 1),
            title: task.title.trim().slice(0, 120),
            detail: task.detail.trim().slice(0, 600),
            successCriteria: task.successCriteria.trim().slice(0, 300),
            status: 'awaiting_approval' as const,
          };
        });
        const record = {
          title: goalTitle,
          context: goalContext,
          summary: plan.summary.trim().slice(0, 1200),
          tasks,
          createdAt: new Date().toISOString(),
        };
        const [id] = await db.add('autonomy_' + user!.userId.replace(/[^A-Za-z0-9_]/g, '_'), [record]);
        if (!id) return error('The plan could not be saved. Please try again.', 500);
        return json({ goal: { id, ...record } }, 201);
      } catch (err) {
        console.error('DAVImth goal planning failed', err);
        const rpcError = err as { statusCode?: number; responseText?: string };
        if (rpcError?.statusCode === 429) return error('The AI planner is temporarily at its shared usage limit. Please try again later.', 429);
        return error('DAVImth could not create a reliable plan. Please try again.', 500);
      }
    },
  ],
  'PUT /api/autonomy/goals/:goalId/tasks/:taskId': [
    requireAuth(),
    async ({ user, params, body }) => {
      if (!body || typeof body !== 'object' || !('status' in body)) return error('A task decision is required.', 400);
      const status = (body as { status?: unknown }).status;
      if (status !== 'approved' && status !== 'rejected') return error('Choose approve or reject.', 400);
      const table = 'autonomy_' + user!.userId.replace(/[^A-Za-z0-9_]/g, '_');
      const [goal] = await db.get<{
        title: string;
        context: string;
        summary: string;
        tasks: Array<{ id: string; title: string; detail: string; successCriteria: string; status: 'awaiting_approval' | 'approved' | 'rejected' | 'queued' | 'preparing' | 'prepared' | 'preparation_failed' | 'cancelled'; preparation?: { runId: string; status: 'queued' | 'running' | 'prepared' | 'preparation_failed' | 'cancelled'; startedAt: string; finishedAt: string; objective?: string; checklist?: string[]; deliverable?: string; risks?: string[]; error?: string } }>;
        createdAt: string;
      }>(table, [params.goalId], { consistent: true });
      if (!goal || !Array.isArray(goal.tasks)) return error('Goal not found.', 404);
      const task = goal.tasks.find(item => item.id === params.taskId);
      if (!task) return error('Task not found.', 404);
      if (task.status !== 'awaiting_approval') return error('This task has already been reviewed.', 409);
      const tasks = goal.tasks.map(item => item.id === params.taskId ? { ...item, status } : item);
      const [updated] = await db.update(table, [{ id: params.goalId, record: { ...goal, tasks } }]);
      if (!updated) return error('The task decision could not be saved.', 500);
      return json({ updated: true, status });
    },
  ],
  'POST /api/autonomy/goals/:goalId/tasks/:taskId/prepare': [
    requireAuth(),
    async ({ user, params, event }) => {
      const rate = await enforceAiRateLimit(event, 'planner');
      if (!rate.allowed) return error(rate.message, rate.status);
      const table = 'autonomy_' + user!.userId.replace(/[^A-Za-z0-9_]/g, '_');
      const [goal] = await db.get<{
        title: string;
        context: string;
        summary: string;
        tasks: Array<{ id: string; title: string; detail: string; successCriteria: string; status: 'awaiting_approval' | 'approved' | 'rejected' | 'queued' | 'preparing' | 'prepared' | 'preparation_failed' | 'cancelled'; preparation?: { runId: string; status: 'queued' | 'running' | 'prepared' | 'preparation_failed' | 'cancelled'; startedAt: string; finishedAt: string; objective?: string; checklist?: string[]; deliverable?: string; risks?: string[]; error?: string } }>;
        createdAt: string;
      }>(table, [params.goalId], { consistent: true });
      if (!goal || !Array.isArray(goal.tasks)) return error('Goal not found.', 404);
      const task = goal.tasks.find(item => item.id === params.taskId);
      if (!task) return error('Task not found.', 404);
      if (task.status !== 'approved' && task.status !== 'preparation_failed') {
        return error(task.status === 'preparing' ? 'This task is already being prepared.' : 'Approve this task before starting its preparation.', 409);
      }

      const startedAt = new Date().toISOString();
      const runId = 'prep-' + Date.now().toString(36);
      const preparingTasks = goal.tasks.map(item => item.id === params.taskId
        ? { ...item, status: 'preparing' as const, preparation: { runId, status: 'running' as const, startedAt, finishedAt: startedAt } }
        : item);
      const [claimed] = await db.tx.update(table, [{
        id: params.goalId,
        record: { tasks: preparingTasks },
        if: { tasks: goal.tasks },
      }], { patch: true });
      if (!claimed) return error('This task changed before the preparation run could start. Refresh and try again.', 409);

      try {
        const result = await generateWithIntelligence('autonomy', {
          system: 'You are DAVImth Safe Preparation Worker. Produce an internal work package for one already-approved task. Do not execute the task, browse the web, call tools, write or run code, contact people, publish, spend money, access external accounts, or change external data. Do not claim that the goal itself is completed. Provide practical steps, a concrete deliverable outline and risks for human review. Respect the supplied constraints. Return only the requested structured result.',
          prompt: 'Prepare an internal work package for this approved task. Overall goal: ' + goal.title + '\nGoal context and boundaries: ' + (goal.context || 'None supplied.') + '\nTask: ' + task.title + '\nTask details: ' + task.detail + '\nSuccess criteria: ' + task.successCriteria + '\nReturn a short objective, 3 to 7 actionable preparation checklist items, an expected deliverable, and up to 4 risks or assumptions to review. Do not perform the work itself.',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              objective: { type: 'string' },
              checklist: { type: 'array', minItems: 3, maxItems: 7, items: { type: 'string' } },
              deliverable: { type: 'string' },
              risks: { type: 'array', maxItems: 4, items: { type: 'string' } },
            },
            required: ['objective', 'checklist', 'deliverable', 'risks'],
          },
          maxTokens: 1100,
          temperature: 0.2,
          thinkingMode: 'DEEP',
        });
        const packageData = JSON.parse(result.text) as { objective?: unknown; checklist?: unknown; deliverable?: unknown; risks?: unknown };
        if (typeof packageData.objective !== 'string' || !Array.isArray(packageData.checklist)
          || packageData.checklist.length < 3 || packageData.checklist.length > 7
          || !packageData.checklist.every(item => typeof item === 'string')
          || typeof packageData.deliverable !== 'string' || !Array.isArray(packageData.risks)
          || !packageData.risks.every(item => typeof item === 'string') || packageData.risks.length > 4) {
          throw new Error('The preparation worker returned an incomplete work package.');
        }
        const [latest] = await db.get<typeof goal>(table, [params.goalId], { consistent: true });
        if (!latest || !Array.isArray(latest.tasks)) return error('The goal could not be reloaded after preparation.', 500);
        const currentTask = latest.tasks.find(item => item.id === params.taskId);
        if (!currentTask || currentTask.status !== 'preparing' || currentTask.preparation?.runId !== runId) {
          return error('The preparation run changed before it could be saved. Refresh the goal to inspect its status.', 409);
        }
        const finishedAt = new Date().toISOString();
        const preparedTasks = latest.tasks.map(item => item.id === params.taskId ? {
          ...item,
          status: 'prepared' as const,
          preparation: {
            runId,
            status: 'prepared' as const,
            startedAt,
            finishedAt,
            objective: packageData.objective as string,
            checklist: (packageData.checklist as string[]).map(value => value.slice(0, 240)),
            deliverable: (packageData.deliverable as string).slice(0, 500),
            risks: (packageData.risks as string[]).map(value => value.slice(0, 240)),
          },
        } : item);
        const [saved] = await db.tx.update(table, [{
          id: params.goalId,
          record: { tasks: preparedTasks },
          if: { tasks: latest.tasks },
        }], { patch: true });
        if (!saved) return error('The work package was generated but the task changed before it could be saved. Refresh and review the task.', 409);
        return json({ prepared: true, message: 'Internal work package prepared. The task itself has not been executed.', preparation: preparedTasks.find(item => item.id === params.taskId)?.preparation });
      } catch (err) {
        console.error('DAVImth safe preparation run failed', err);
        const [latest] = await db.get<typeof goal>(table, [params.goalId], { consistent: true });
        if (latest && Array.isArray(latest.tasks)) {
          const currentTask = latest.tasks.find(item => item.id === params.taskId);
          if (currentTask?.status === 'preparing' && currentTask.preparation?.runId === runId) {
            const failedTasks = latest.tasks.map(item => item.id === params.taskId ? {
              ...item,
              status: 'preparation_failed' as const,
              preparation: { runId, status: 'preparation_failed' as const, startedAt, finishedAt: new Date().toISOString(), error: 'Preparation failed. You can retry after reviewing the task.' },
            } : item);
            await db.tx.update(table, [{ id: params.goalId, record: { tasks: failedTasks }, if: { tasks: latest.tasks } }], { patch: true });
          }
        }
        const rpcError = err as { statusCode?: number };
        if (rpcError?.statusCode === 429) return error('DAVImth is temporarily at its shared AI usage limit. Please try again later.', 429);
        return error('DAVImth could not prepare this task. No external action was taken.', 500);
      }
    },
  ],
  'POST /api/autonomy/goals/:goalId/tasks/:taskId/queue': [
    requireAuth(),
    async ({ user, params }) => {
      const table = 'autonomy_' + user!.userId.replace(/[^A-Za-z0-9_]/g, '_');
      const [goal] = await db.get<{ tasks: Array<{ id: string; title: string; status: string }> }>(table, [params.goalId], { consistent: true });
      if (!goal?.tasks) return error('Goal not found.', 404);
      const task = goal.tasks.find(entry => entry.id === params.taskId);
      if (!task) return error('Task not found.', 404);
      if (task.status !== 'approved' && task.status !== 'preparation_failed') return error('Only an approved task can be queued.', 409);
      const runId = 'run_' + hashRateKey(user!.userId + ':' + params.goalId + ':' + params.taskId + ':' + Date.now() + ':' + Math.random());
      const createdAt = new Date().toISOString();
      const tasks = goal.tasks.map(entry => entry.id === params.taskId
        ? { ...entry, status: 'queued', preparation: { runId, status: 'queued', startedAt: createdAt, finishedAt: createdAt } }
        : entry);
      const addRun = db.tx.add('autonomy_run_queue', [{
        id: runId, userId: user!.userId, goalId: params.goalId, taskId: params.taskId,
        taskTitle: task.title, status: 'queued', createdAt,
      }]);
      const updateGoal = db.tx.update(table, [{ id: params.goalId, record: { tasks }, if: { tasks: goal.tasks } }], { patch: true });
      try {
        await db.transact([addRun, updateGoal]);
        return json({ queued: true, runId, message: 'Task added to the cloud queue. The scheduled worker will process it.' }, 202);
      } catch (err) {
        console.error('DAVImth queue submission failed', err);
        return error('The task could not be queued. Refresh and try again.', 500);
      }
    },
  ],
  'POST /api/autonomy/goals/:goalId/tasks/:taskId/cancel': [
    requireAuth(),
    async ({ user, params }) => {
      const table = 'autonomy_' + user!.userId.replace(/[^A-Za-z0-9_]/g, '_');
      const [goal] = await db.get<{ tasks: Array<{ id: string; status: string; preparation?: { runId: string } }> }>(table, [params.goalId], { consistent: true });
      if (!goal?.tasks) return error('Goal not found.', 404);
      const task = goal.tasks.find(entry => entry.id === params.taskId);
      if (!task?.preparation?.runId || (task.status !== 'queued' && task.status !== 'preparing')) return error('No active background run was found.', 409);
      const [run] = await db.get<AutonomyQueueItem>('autonomy_run_queue', [task.preparation.runId], { consistent: true });
      if (!run || run.userId !== user!.userId || run.goalId !== params.goalId || run.taskId !== params.taskId) return error('Background run not found.', 404);
      const finishedAt = new Date().toISOString();
      const [cancelled] = await db.tx.update('autonomy_run_queue', [{ id: run.id, record: { status: 'cancelled', finishedAt }, if: { status: run.status } }], { patch: true });
      if (!cancelled) return error('The run changed before cancellation. Refresh and try again.', 409);
      const tasks = goal.tasks.map(entry => entry.id === params.taskId
        ? { ...entry, status: 'cancelled', preparation: { ...entry.preparation, status: 'cancelled', finishedAt } }
        : entry);
      const [updated] = await db.tx.update(table, [{ id: params.goalId, record: { tasks }, if: { tasks: goal.tasks } }], { patch: true });
      if (!updated) return error('The run was cancelled. Refresh the goal to see its latest status.', 409);
      return json({ cancelled: true, message: 'Background run cancelled. If AI processing had started, its result will be discarded.' });
    },
  ],
  'GET /api/workspace': [
    requireAuth(),
    async ({ user }) => {
      const table = tableFor(user!.userId);
      let result = await db.list<WorkspaceItem>(table, { limit: 100 });
      if (!result.items.some(item => item.kind === 'business')) {
        const defaults: WorkspaceItem[] = [
          { kind: 'business', title: 'DAVIMART', detail: 'Marketplace operations', businessName: 'DAVIMART', status: 'active', createdAt: new Date().toISOString() },
          { kind: 'business', title: 'DAVITECH', detail: 'Digital services and customer support', businessName: 'DAVITECH', status: 'active', createdAt: new Date().toISOString() },
        ];
        await db.add(table, defaults);
        result = await db.list<WorkspaceItem>(table, { limit: 100 });
      }
      return json({ records: result.items });
    },
  ],
  'POST /api/workspace': [
    requireAuth(),
    async ({ user, body }) => {
      if (!body || typeof body !== 'object') return error('A record is required.', 400);
      const input = body as WorkspaceInput;
      if (input.kind !== 'business' && input.kind !== 'task') return error('Choose a business or task record.', 400);
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100) return error('Enter a title of up to 100 characters.', 400);
      if (typeof input.detail !== 'string' || input.detail.length > 1000) return error('Notes must be 1000 characters or fewer.', 400);
      if (typeof input.businessName !== 'string' || input.businessName.length > 100) return error('Enter a valid business name.', 400);
      const item: WorkspaceItem = {
        kind: input.kind,
        title: input.title.trim(),
        detail: input.detail.trim(),
        businessName: input.businessName.trim(),
        status: input.kind === 'business' ? 'active' : 'open',
        createdAt: new Date().toISOString(),
      };
      const [id] = await db.add(tableFor(user!.userId), [item]);
      if (!id) return error('The record could not be saved.', 500);
      return json({ id, record: { ...item, id } }, 201);
    },
  ],
  'PATCH /api/workspace/:id': [
    requireAuth(),
    async ({ user, params, body }) => {
      if (!body || typeof body !== 'object' || !('status' in body)) return error('A status is required.', 400);
      const status = (body as { status?: unknown }).status;
      if (status !== 'open' && status !== 'done') return error('Choose a valid task status.', 400);
      const table = tableFor(user!.userId);
      const [existing] = await db.get<WorkspaceItem>(table, [params.id], { consistent: true });
      if (!existing || existing.kind !== 'task') return error('Task not found.', 404);
      const [updated] = await db.update(table, [{ id: params.id, record: { ...existing, status } }]);
      if (!updated) return error('Task update failed.', 500);
      return json({ updated: true, status });
    },
  ],
});
