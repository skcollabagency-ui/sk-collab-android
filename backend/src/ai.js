'use strict';

function createAiClient(config) {
  const ai = config.ai || {};

  function isConfigured() {
    return Boolean(ai.provider && ai.apiKey && ai.model);
  }

  function baseUrl() {
    if (ai.baseUrl) return ai.baseUrl.replace(/\/+$/, '');
    if (ai.provider === 'openai') return 'https://api.openai.com/v1';
    if (ai.provider === 'groq') return 'https://api.groq.com/openai/v1';
    if (ai.provider === 'ollama') return 'https://ollama.com/api';
    return '';
  }

  async function complete(systemPrompt, userPrompt, maxTokens) {
    if (!isConfigured()) {
      return {
        available: false,
        summary: null,
        reason: 'No backend AI provider is configured (AI_PROVIDER, AI_MODEL, AI_API_KEY). The app can still summarize the returned message text with its own AI model.'
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      let url;
      let body;
      if (ai.provider === 'ollama') {
        url = `${baseUrl()}/chat`;
        body = {
          model: ai.model,
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        };
      } else if (ai.provider === 'openai' || ai.provider === 'groq') {
        url = `${baseUrl()}/chat/completions`;
        body = {
          model: ai.model,
          temperature: 0.2,
          max_tokens: maxTokens || 700,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        };
      } else {
        throw new Error(`Unsupported AI_PROVIDER: ${ai.provider}`);
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ai.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`AI provider returned HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      const parsed = JSON.parse(text);
      let summary = '';
      if (ai.provider === 'ollama') {
        summary = (parsed.message && parsed.message.content) || '';
      } else {
        summary =
          (parsed.choices &&
            parsed.choices[0] &&
            parsed.choices[0].message &&
            parsed.choices[0].message.content) ||
          '';
      }
      if (!summary.trim()) throw new Error('AI provider returned an empty response.');
      return {
        available: true,
        summary: summary.trim(),
        provider: ai.provider,
        model: ai.model
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function summarizeReplies(threads, contextText) {
    if (!threads || !threads.length) {
      return { available: isConfigured(), summary: 'No matching email messages were found.' };
    }
    const transcript = threads
      .slice(0, 8)
      .map((thread) => {
        const latest = thread.latest || {};
        return (
          `Thread ${thread.id || ''}\n` +
          `From: ${latest.from || ''}\nSubject: ${latest.subject || ''}\n` +
          `Date: ${latest.date || ''}\n` +
          `${(latest.bodyText || latest.snippet || '').slice(0, 4000)}`
        );
      })
      .join('\n\n===\n\n');
    const system =
      'You summarize real business email replies for an Indian creator-brand agency. ' +
      'Only use facts present in the supplied messages. Never invent brands, creators, prices, ' +
      'commitments, or dates. Mark unclear items as unclear. Output: (1) who replied, ' +
      '(2) what they asked or decided, (3) any rate/deal terms explicitly stated, ' +
      '(4) recommended next action, (5) follow-up timing if stated.';
    const user = `Agency context:\n${contextText || 'Not available'}\n\nReal Gmail threads:\n${transcript}`;
    try {
      return await complete(system, user, 900);
    } catch (error) {
      return {
        available: false,
        summary: null,
        reason: error.message,
        fallbackInstruction: 'Summarize the returned real message text in the app without adding facts.'
      };
    }
  }

  return { isConfigured, complete, summarizeReplies };
}

module.exports = { createAiClient };
