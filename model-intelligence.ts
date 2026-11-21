import { ai, secrets } from '@appdeploy/sdk';

export type IntelligenceTask = 'education' | 'business' | 'growth' | 'general' | 'autonomy';

type GenerateOptions = Parameters<typeof ai.generate>[0];
type ProviderName = 'openai' | 'gemini' | 'groq' | 'appdeploy';
type ProviderResult = { text: string };

const profiles: Record<IntelligenceTask, {
  id: string;
  purpose: string;
  thinkingMode: 'NONE' | 'FAST' | 'DEEP';
  maxTokens: number;
}> = {
  education: { id: 'learning-tutor', purpose: 'Explain, teach and guide learners step by step.', thinkingMode: 'DEEP', maxTokens: 900 },
  business: { id: 'business-assistant', purpose: 'Ground answers in business facts and customer policies.', thinkingMode: 'FAST', maxTokens: 700 },
  growth: { id: 'marketing-strategist', purpose: 'Create useful, accurate marketing content.', thinkingMode: 'FAST', maxTokens: 900 },
  general: { id: 'general-assistant', purpose: 'Handle general conversation and multimodal questions.', thinkingMode: 'DEEP', maxTokens: 1500 },
  autonomy: { id: 'planning-engine', purpose: 'Plan and prepare bounded tasks without executing external actions.', thinkingMode: 'DEEP', maxTokens: 900 },
};

const providerConfig = {
  openai: { secret: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
  gemini: { secret: 'GEMINI_API_KEY', model: 'gemini-2.5-flash' },
  groq: { secret: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile' },
} as const;

async function configuredSecrets() {
  const names = await secrets.listSecretNames();
  return {
    openai: names.includes(providerConfig.openai.secret),
    gemini: names.includes(providerConfig.gemini.secret),
    groq: names.includes(providerConfig.groq.secret),
    elevenlabs: names.includes('ELEVENLABS_API_KEY'),
  };
}

export async function getModelIntelligenceStatus() {
  const configured = await configuredSecrets();
  return {
    name: 'DAVImth Multi-Provider Intelligence Layer',
    architectureVersion: '0.2',
    routing: 'task-aware provider routing with automatic fallback',
    providers: [
      { id: 'openai', name: 'OpenAI', configured: configured.openai, model: providerConfig.openai.model, capabilities: ['text', 'images'] },
      { id: 'gemini', name: 'Google Gemini', configured: configured.gemini, model: providerConfig.gemini.model, capabilities: ['text', 'images'] },
      { id: 'groq', name: 'Groq', configured: configured.groq, model: providerConfig.groq.model, capabilities: ['text'] },
      { id: 'appdeploy', name: 'AppDeploy managed AI', configured: true, model: 'managed-default', capabilities: ['text', 'images', 'audio', 'structured-output'] },
      { id: 'elevenlabs', name: 'ElevenLabs', configured: configured.elevenlabs, capabilities: ['speech'] },
    ],
    profiles: Object.entries(profiles).map(([task, profile]) => ({
      task, profile: profile.id, purpose: profile.purpose,
      defaultThinkingMode: profile.thinkingMode, defaultMaxTokens: profile.maxTokens,
    })),
    note: 'API keys are read only by the backend. Provider availability is based on configured secret names; live authentication is verified when a request is made.',
  };
}

function buildPrompt(options: GenerateOptions) {
  const parts: string[] = [];
  if (options.system) parts.push('SYSTEM INSTRUCTIONS:\n' + options.system);
  if (options.prompt) parts.push(options.prompt);
  if (options.messages?.length) {
    parts.push('CONVERSATION:\n' + options.messages.map(message => message.role.toUpperCase() + ': ' + message.content).join('\n'));
  }
  if (options.schema) {
    parts.push('Return only valid JSON matching this schema. Do not include Markdown fences:\n' + JSON.stringify(options.schema));
  }
  return parts.join('\n\n');
}

function imageDataUrl(image: { data: string; mimeType: string }) {
  return 'data:' + image.mimeType + ';base64,' + image.data;
}

async function callOpenAI(key: string, options: GenerateOptions): Promise<ProviderResult> {
  const userMessages = (options.messages || []).map(message => ({
    role: message.role === 'model' ? 'assistant' : message.role,
    content: message.content,
  }));
  const messages: Array<Record<string, unknown>> = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  if (userMessages.length) messages.push(...userMessages);
  else messages.push({ role: 'user', content: options.prompt || '' });
  if (options.images?.length) {
    const last = messages[messages.length - 1];
    const text = typeof last.content === 'string' ? last.content : '';
    last.content = [
      { type: 'text', text },
      ...options.images.map(image => ({ type: 'image_url', image_url: { url: imageDataUrl(image) } })),
    ];
  }
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: providerConfig.openai.model,
      messages,
      max_tokens: options.maxTokens || 1000,
      temperature: options.temperature ?? 0.6,
      ...(options.schema ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error('OpenAI request failed (' + response.status + '): ' + (payload.error?.message || 'provider error'));
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned an empty response.');
  return { text };
}

async function callGemini(key: string, options: GenerateOptions): Promise<ProviderResult> {
  const prompt = buildPrompt(options);
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const image of options.images || []) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  }
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + providerConfig.gemini.model + ':generateContent?key=' + encodeURIComponent(key),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          maxOutputTokens: options.maxTokens || 1000,
          temperature: options.temperature ?? 0.6,
          ...(options.schema ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    },
  );
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
  if (!response.ok) throw new Error('Gemini request failed (' + response.status + '): ' + (payload.error?.message || 'provider error'));
  const text = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
  if (!text) throw new Error('Gemini returned an empty response.');
  return { text };
}

async function callGroq(key: string, options: GenerateOptions): Promise<ProviderResult> {
  const messages: Array<Record<string, unknown>> = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  if (options.messages?.length) {
    messages.push(...options.messages.map(message => ({
      role: message.role === 'model' ? 'assistant' : message.role,
      content: message.content,
    })));
  } else {
    messages.push({ role: 'user', content: options.prompt || '' });
  }
  if (options.schema) messages.push({
    role: 'system',
    content: 'Return only valid JSON matching this schema. Do not include Markdown fences: ' + JSON.stringify(options.schema),
  });
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: providerConfig.groq.model,
      messages,
      max_tokens: options.maxTokens || 1000,
      temperature: options.temperature ?? 0.6,
      ...(options.schema ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error('Groq request failed (' + response.status + '): ' + (payload.error?.message || 'provider error'));
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned an empty response.');
  return { text };
}

export async function generateWithIntelligence(task: IntelligenceTask, options: GenerateOptions) {
  const profile = profiles[task];
  const request: GenerateOptions = {
    ...options,
    maxTokens: options.maxTokens ?? profile.maxTokens,
    thinkingMode: options.thinkingMode ?? profile.thinkingMode,
  };

  // Preserve the managed multimodal path for audio and tool-calling requests.
  if (request.audios?.length || request.tools?.length) {
    console.info('DAVImth route: managed AI required for audio or tool calling', { task });
    return ai.generate(request);
  }

  const configured = await configuredSecrets();
  const candidates: ProviderName[] = request.images?.length
    ? ['openai', 'gemini', 'appdeploy']
    : task === 'general'
      ? ['openai', 'gemini', 'groq', 'appdeploy']
      : task === 'education'
        ? ['gemini', 'openai', 'groq', 'appdeploy']
        : ['openai', 'groq', 'gemini', 'appdeploy'];

  const failures: string[] = [];
  for (const provider of candidates) {
    try {
      let result: ProviderResult;
      if (provider === 'openai' && configured.openai) {
        result = await callOpenAI(await secrets.readSecret(providerConfig.openai.secret), request);
      } else if (provider === 'gemini' && configured.gemini) {
        result = await callGemini(await secrets.readSecret(providerConfig.gemini.secret), request);
      } else if (provider === 'groq' && configured.groq && !request.images?.length) {
        result = await callGroq(await secrets.readSecret(providerConfig.groq.secret), request);
      } else if (provider === 'appdeploy') {
        const managed = await ai.generate(request);
        result = { text: managed.text };
      } else {
        continue;
      }

      console.info('DAVImth provider selected', { task, provider, profile: profile.id });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown provider failure';
      console.warn('DAVImth provider fallback', { task, provider, reason: message.slice(0, 180) });
      failures.push(provider + ': ' + message.slice(0, 180));
    }
  }

  throw new Error('All configured DAVImth AI providers failed. ' + failures.join(' | '));
}
