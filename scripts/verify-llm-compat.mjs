#!/usr/bin/env node

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import {
  BlockAssembler,
  CallId,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';

import { startFakeCpa } from '../tests/fixtures/fake-cpa/index.js';

const require = createRequire(import.meta.url);
const RC6 = '0.1.0-rc.6';
const PROVIDER = 'fake-cpa';
const TEXT_MODEL = 'fake-text-model';
const IMAGE_MODEL = 'fake-vision-model';
const CHAT_PATH = '/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 5_000;

let currentCapability = 'startup';

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function errorMessage(error) {
  if (error instanceof AggregateError) {
    const details = error.errors.map((item) => errorMessage(item)).join('; ');
    return `${error.message}: ${details}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function jsonLine(prefix, value) {
  return `${prefix} ${JSON.stringify(value)}\n`;
}

async function withTimeout(promise, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function runCapability(name, callback) {
  currentCapability = name;
  const evidence = await callback();
  process.stdout.write(jsonLine('PASS', { capability: name, ...evidence }));
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function finalChunk(chunks) {
  const chunk = chunks.at(-1);
  expect(chunk?.type === 'finish', `stream did not end with a finish chunk: ${JSON.stringify(chunk)}`);
  return chunk;
}

function textFrom(chunks) {
  return chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('');
}

function requestSummary(observation) {
  const messages = Array.isArray(observation?.body?.messages) ? observation.body.messages : [];
  const imageParts = messages.flatMap((message) => Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === 'image_url' || part?.type === 'input_image');
  return {
    cpaRequestId: observation?.id,
    cpaMethod: observation?.method,
    cpaPath: observation?.path,
    cpaRequest: {
      model: observation?.body?.model,
      stream: observation?.body?.stream,
      messageCount: messages.length,
      messageRoles: messages.map((message) => message?.role),
      toolNames: Array.isArray(observation?.body?.tools)
        ? observation.body.tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
        : [],
      toolResultCallIds: messages.map((message) => message?.tool_call_id).filter(Boolean),
      imagePartCount: imageParts.length,
      imageUrlPrefix: imageParts[0]?.image_url?.url?.slice(0, 22),
    },
    cpaResponse: {
      status: observation?.response?.status,
      completed: observation?.response?.completed,
      eventCount: observation?.response?.events?.length ?? 0,
    },
  };
}

function assertCompletedCpaRequest(observation, label) {
  expect(observation !== undefined, `${label}: fake CPA did not observe a request`);
  expect(observation.path === CHAT_PATH, `${label}: unexpected CPA path ${observation.path}`);
  expect(observation.method === 'POST', `${label}: unexpected CPA method ${observation.method}`);
  expect(observation.response?.status === 200, `${label}: fake CPA response status was ${observation.response?.status}`);
  expect(observation.response?.completed === true, `${label}: fake CPA response did not complete`);
}

function countChatRequests(fixture) {
  return fixture.requests.filter((request) => request.path === CHAT_PATH).length;
}

function textMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

function imageMessage(text, attachment) {
  return createUserMessage({
    content: [
      { type: 'text', text },
      { type: 'image', attachment },
    ],
    source: { kind: 'user' },
  });
}

function llmOptions(model, messages, extra = {}) {
  return {
    provider: PROVIDER,
    model,
    messages,
    ...extra,
  };
}

async function packageEvidence() {
  const packagePath = require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json');
  const builtPath = require.resolve('@deepseek-ai/dsh-llm-pi-ai');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  expect(packageJson.version === RC6, `official llm-pi-ai package version was ${packageJson.version}, expected ${RC6}`);
  expect(builtPath.endsWith('/lib/index.js') || builtPath.endsWith('\\lib\\index.js'), `llm-pi-ai did not resolve to its built lib/index.js: ${builtPath}`);
  return { package: '@deepseek-ai/dsh-llm-pi-ai', version: packageJson.version, packagePath, builtPath };
}

async function startApplication(fixture, dshHome) {
  const ctx = new Context();
  await ctx.plugin(Loader, { baseUrl: import.meta.url });
  await ctx.loader.create({ id: 'llm-runtime', name: '@deepseek-ai/dsh-llm' });
  await ctx.loader.create({
    id: 'attachment-local',
    name: '@deepseek-ai/dsh-attachment-local',
    config: { dshHome },
  });
  await ctx.loader.create({
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: {
      providers: {
        [PROVIDER]: {
          displayName: 'Fake CPA',
          api: 'openai-completions',
          baseURL: `${fixture.url}/v1`,
          headers: { authorization: 'Bearer fixture-key' },
          models: [
            {
              id: TEXT_MODEL,
              name: 'Fake text model',
              contextWindow: 32_768,
              maxTokens: 1_024,
              input: ['text'],
            },
            {
              id: IMAGE_MODEL,
              name: 'Fake vision model',
              contextWindow: 32_768,
              maxTokens: 1_024,
              input: ['text', 'image'],
            },
          ],
        },
      },
    },
  });
  await ctx.loader.await();
  return ctx;
}

async function stopApplication(ctx) {
  if (ctx === undefined) return [];
  const errors = [];
  for (const id of ['llm-pi-ai', 'attachment-local', 'llm-runtime']) {
    try {
      ctx.loader.resolve(id);
      await ctx.loader.remove(id);
    } catch (error) {
      if (!/cannot resolve entry/u.test(errorMessage(error))) errors.push(`${id}: ${errorMessage(error)}`);
    }
  }
  try {
    await ctx.loader.await();
  } catch (error) {
    errors.push(`loader await: ${errorMessage(error)}`);
  }
  return errors;
}

async function main() {
  let fixture;
  let ctx;
  let dshHome;
  let failure;
  let cleanupErrors = [];

  try {
    fixture = await startFakeCpa();
    dshHome = await mkdtemp(join(tmpdir(), 'dsh-llm-compat-'));

    await runCapability('loader-rc6', async () => {
      const packageInfo = await packageEvidence();
      ctx = await startApplication(fixture, dshHome);
      const loadedEntries = ['llm-runtime', 'attachment-local', 'llm-pi-ai'].map((id) => {
        const entry = ctx.loader.resolve(id);
        return { id, name: entry.options.name, active: entry.fiber !== undefined };
      });
      expect(loadedEntries.every((entry) => entry.active), `Loader entries were not active: ${JSON.stringify(loadedEntries)}`);
      expect(ctx.llm.listProviders().some((provider) => provider.id === PROVIDER), `public ctx.llm route ${PROVIDER} was not registered`);
      expect(typeof ctx.attachments.saveImage === 'function', 'public ctx.attachments.saveImage is unavailable');
      return {
        ...packageInfo,
        loaderEntries: loadedEntries,
        provider: PROVIDER,
        attachmentRoot: ctx.attachments.root,
      };
    });

    await runCapability('text-response', async () => {
      const messages = [textMessage('hello')];
      const chunks = await collect(ctx.llm.stream(llmOptions(TEXT_MODEL, messages)));
      const finish = finalChunk(chunks);
      expect(finish.reason.kind === 'stop', `text request finished as ${finish.reason.kind}`);
      expect(textFrom(chunks) === 'Hello from fake CPA.', `unexpected text result ${JSON.stringify(textFrom(chunks))}`);
      const observed = fixture.getLastRequest(CHAT_PATH);
      assertCompletedCpaRequest(observed, 'text response');
      expect(observed.body.model === TEXT_MODEL, 'text response used the wrong model');
      expect(observed.body.messages?.[0]?.content === 'hello', 'text request did not preserve the user message');
      return { text: textFrom(chunks), observed: requestSummary(observed) };
    });

    await runCapability('tool-call-result', async () => {
      const tools = [{
        name: 'get_weather',
        description: 'Read the fixture weather.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
      }];
      const user = textMessage('weather');
      const firstChunks = await collect(ctx.llm.stream(llmOptions(TEXT_MODEL, [user], { tools })));
      const firstFinish = finalChunk(firstChunks);
      expect(firstFinish.reason.kind === 'tool-calls', `tool declaration did not produce tool-calls finish: ${firstFinish.reason.kind}`);
      const assembler = new BlockAssembler();
      for (const chunk of firstChunks) assembler.push(chunk);
      const toolCall = assembler.blocks().find((block) => block.type === 'tool-call');
      expect(toolCall !== undefined, 'tool call block was not assembled');
      expect(toolCall.id === 'call_fake_001', `unexpected tool call id ${toolCall.id}`);
      expect(toolCall.name === 'get_weather', `unexpected tool name ${toolCall.name}`);
      expect(JSON.parse(toolCall.arguments).city === 'San Francisco', `unexpected tool arguments ${toolCall.arguments}`);
      const firstObserved = fixture.getLastRequest(CHAT_PATH);
      assertCompletedCpaRequest(firstObserved, 'tool declaration');
      expect(firstObserved.body.tools?.[0]?.function?.name === 'get_weather', 'CPA did not observe the tool declaration');

      const assistant = assembler.message({ kind: 'model', provider: PROVIDER, model: TEXT_MODEL });
      const result = createToolResultMessage({
        callId: CallId(toolCall.id),
        content: [{ type: 'text', text: '72 degrees' }],
        isError: false,
      });
      const secondChunks = await collect(ctx.llm.stream(llmOptions(TEXT_MODEL, [user, assistant, result], { tools })));
      const secondFinish = finalChunk(secondChunks);
      expect(secondFinish.reason.kind === 'stop', `tool result continuation finished as ${secondFinish.reason.kind}`);
      expect(textFrom(secondChunks) === 'Tool result received.', `unexpected tool continuation ${JSON.stringify(textFrom(secondChunks))}`);
      const secondObserved = fixture.getLastRequest(CHAT_PATH);
      assertCompletedCpaRequest(secondObserved, 'tool result continuation');
      expect(secondObserved.id !== firstObserved.id, 'tool result continuation replayed the first CPA request');
      expect(secondObserved.body.messages?.some((message) => message.role === 'tool'
        && message.tool_call_id === 'call_fake_001'
        && message.content === '72 degrees'), 'CPA did not observe the correlated tool result');
      return {
        tool: { id: toolCall.id, name: toolCall.name, arguments: JSON.parse(toolCall.arguments) },
        continuationText: textFrom(secondChunks),
        firstObserved: requestSummary(firstObserved),
        secondObserved: requestSummary(secondObserved),
      };
    });

    await runCapability('ordered-streaming', async () => {
      fixture.setBehavior(CHAT_PATH, {
        responseText: 'stream fixture text',
        streamDeltas: ['stream-A', '|stream-B'],
      });
      try {
        const chunks = await collect(ctx.llm.stream(llmOptions(TEXT_MODEL, [textMessage('stream')])));
        const finish = finalChunk(chunks);
        expect(finish.reason.kind === 'stop', `ordered stream finished as ${finish.reason.kind}`);
        const deltas = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text);
        expect(JSON.stringify(deltas) === JSON.stringify(['stream-A', '|stream-B']), `stream deltas were reordered: ${JSON.stringify(deltas)}`);
        const observed = fixture.getLastRequest(CHAT_PATH);
        assertCompletedCpaRequest(observed, 'ordered streaming');
        expect(observed.body.stream === true, 'ordered stream did not send stream=true to CPA');
        expect(observed.response.events?.map((event) => event.choices?.[0]?.delta?.content).filter(Boolean)
          .join('') === 'stream-A|stream-B', 'CPA observed stream events in the wrong order');
        return { deltas, observed: requestSummary(observed) };
      } finally {
        fixture.clearBehavior(CHAT_PATH);
      }
    });

    await runCapability('image-opt-in', async () => {
      const imageData = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      const attachment = await ctx.attachments.saveImage({
        data: new Uint8Array(imageData),
        mediaType: 'image/png',
        name: 'fixture.png',
      });
      const textInfo = await ctx.llm.resolveModelInfo(PROVIDER, TEXT_MODEL);
      const imageInfo = await ctx.llm.resolveModelInfo(PROVIDER, IMAGE_MODEL);
      expect(JSON.stringify(textInfo.inputModalities) === JSON.stringify(['text']), `text model modalities drifted: ${JSON.stringify(textInfo.inputModalities)}`);
      expect(JSON.stringify(imageInfo.inputModalities) === JSON.stringify(['text', 'image']), `image model modalities drifted: ${JSON.stringify(imageInfo.inputModalities)}`);

      const beforeRejected = countChatRequests(fixture);
      const rejectedChunks = await collect(ctx.llm.stream(llmOptions(TEXT_MODEL, [imageMessage('describe', attachment)])));
      const rejectedFinish = finalChunk(rejectedChunks);
      expect(rejectedFinish.reason.kind === 'error', `text-only image request finished as ${rejectedFinish.reason.kind}`);
      expect(rejectedFinish.reason.failure.code === 'UNSUPPORTED_CONTENT', `text-only image rejection code was ${rejectedFinish.reason.failure.code}`);
      const afterRejected = countChatRequests(fixture);
      expect(afterRejected === beforeRejected, 'text-only image rejection made an outbound CPA request');

      const acceptedChunks = await collect(ctx.llm.stream(llmOptions(IMAGE_MODEL, [imageMessage('describe', attachment)])));
      const acceptedFinish = finalChunk(acceptedChunks);
      expect(acceptedFinish.reason.kind === 'stop', `image-enabled model finished as ${acceptedFinish.reason.kind}`);
      const acceptedObserved = fixture.getLastRequest(CHAT_PATH);
      assertCompletedCpaRequest(acceptedObserved, 'image-enabled model');
      expect(acceptedObserved.body.model === IMAGE_MODEL, 'image-enabled request used the wrong model');
      const imagePart = acceptedObserved.body.messages?.[0]?.content?.find((part) => part.type === 'image_url');
      expect(imagePart?.image_url?.url?.startsWith('data:image/png;base64,'), 'CPA did not observe the DSH attachment as an image data URL');
      return {
        attachment: { id: attachment.attachmentId, bytes: attachment.bytes, width: attachment.width, height: attachment.height, root: ctx.attachments.root },
        rejected: { finish: rejectedFinish.reason, cpaRequestCountDelta: afterRejected - beforeRejected },
        accepted: requestSummary(acceptedObserved),
      };
    });

    await runCapability('abort-cancellation', async () => {
      fixture.setBehavior(CHAT_PATH, { delayMs: 1_000, abortObservable: true });
      const before = countChatRequests(fixture);
      const controller = new AbortController();
      const iterator = ctx.llm.stream(llmOptions(TEXT_MODEL, [textMessage('abort')], { signal: controller.signal }))[Symbol.asyncIterator]();
      const firstNext = iterator.next();
      const request = await withTimeout(fixture.waitForRequest({
        path: CHAT_PATH,
        method: 'POST',
        predicate: (candidate) => candidate.body?.messages?.[0]?.content === 'abort',
      }), 'abort CPA request');
      expect(request.body.messages?.[0]?.content === 'abort', 'abort request did not preserve the test message');
      controller.abort();

      const chunks = [];
      let next = await withTimeout(firstNext, 'aborted stream completion');
      while (!next.done) {
        chunks.push(next.value);
        next = await withTimeout(iterator.next(), 'aborted stream drain');
      }
      const finish = finalChunk(chunks);
      expect(finish.reason.kind === 'aborted', `abort did not end the stream as aborted: ${finish.reason.kind}`);
      await waitUntil(() => {
        const observed = fixture.getLastRequest(CHAT_PATH);
        return observed?.aborted === true && observed.response?.completed === false;
      }, 'fake CPA abort observation');
      const observed = fixture.getLastRequest(CHAT_PATH);
      expect(countChatRequests(fixture) === before + 1, 'abort caused a replayed CPA request');
      expect(observed.abortObservable === true, 'fake CPA abort behavior was not observed');
      return {
        finish: finish.reason,
        observed: {
          ...requestSummary(observed),
          aborted: observed.aborted,
          abortObservable: observed.abortObservable,
        },
      };
    });
  } catch (error) {
    failure = error;
  } finally {
    cleanupErrors = await stopApplication(ctx);
    if (fixture !== undefined) {
      try {
        await fixture.close();
      } catch (error) {
        cleanupErrors.push(`fake CPA close: ${errorMessage(error)}`);
      }
    }
    if (dshHome !== undefined) {
      try {
        await rm(dshHome, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(`temporary attachment home cleanup: ${errorMessage(error)}`);
      }
    }
  }

  if (failure !== undefined) {
    process.stderr.write(jsonLine('FAIL', {
      capability: currentCapability,
      error: errorMessage(failure),
      cleanupErrors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
    }));
    process.exitCode = 1;
    return;
  }
  if (cleanupErrors.length > 0) {
    process.stderr.write(jsonLine('FAIL', { capability: 'cleanup', error: cleanupErrors.join('; ') }));
    process.exitCode = 1;
  }
}

await main();
