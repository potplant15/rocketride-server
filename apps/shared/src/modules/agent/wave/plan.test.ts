// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// WAVE PLAN TESTS — the question sent, and reading GPT-5.5's replies
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORE_PROMPT } from '../prompts';
import { buildWaveQuestion, parseReply, type PlanReply, type PromptPrefix } from './plan';

// =============================================================================
// FIXTURES — GPT-5.5's plan replies, trimmed
// =============================================================================

/**
 * Real replies from GPT-5.5 runs of the build-01 and build-02 eval scenarios.
 * The thoughts, separators and tool calls are the model's; scratch notes are
 * cut short and some calls dropped. Each reply's first block is the plan for
 * that wave; any block after it guesses at later waves.
 */

/** A block in a json fence, the way the model writes it. */
function fenced(body: string): string {
	return '```json\n' + body + '\n```';
}

/** build-01 wave 0: one clean block. */
const CLEAN = fenced('{"thought":"I’m getting oriented and reading the required RocketRide pipeline guides before creating the support-chat pipeline.","scratch":"Goal: build pipeline named support-chat for chatting with Claude Sonnet 4.6 using existing Anthropic key in Variables.","remove":[],"tool_calls":[{"tool":"list_workspace","args":{}},{"tool":"read_file","args":{"path":".rocketride/skills/rocketride-building-pipelines/SKILL.md"}}]}');

/** build-01 wave 3: the same block twice. */
const DUPLICATE_BLOCK = '{"thought":"I need the exact Anthropic profile shape and environment-variable placeholder before writing the pipeline so validation does not rely on guesses.","scratch":"Live providers chosen: chat (_source→questions), llm_anthropic (questions→answers), response_answers (answers terminal).","remove":["wave-2.r0","wave-2.r2"],"tool_calls":[{"tool":"memory.peek","args":{"key":"wave-2.r1","path":"Pipe.schema.dependencies.profile.oneOf[1]"}},{"tool":"search_files","args":{"pattern":"ROCKETRIDE_ANTHROPIC","path":".rocketride","maxResults":50}}]}';
const DUPLICATE = fenced(DUPLICATE_BLOCK) + ' \n' + fenced(DUPLICATE_BLOCK);

/** build-02 wave 2: the plan, then a block that finishes while it waits for the plan's results. */
const WAITING = fenced('{"thought":"I need the exact provider names, lanes, and configuration schemas for the webhook and OpenAI model components before writing the pipeline.","scratch":"Need describe webhook and OpenAI component(s).","remove":[],"tool_calls":[{"tool":"describe_component","args":{"name":"webhook"}},{"tool":"describe_component","args":{"name":"llm_openai"}},{"tool":"describe_component","args":{"name":"openai"}}]}') + ' \n' + fenced('{"thought":"I’m waiting for the component descriptions so I can create the pipeline with valid providers and wiring.","scratch":"Need describe webhook and OpenAI component(s).","remove":[],"done":true,"answer":"I’m waiting for the component descriptions needed to create the pipeline correctly."}');

/** build-01 wave 1: the same, with no newline between the closing fence and the next opening one. */
const WAITING_FUSED = fenced('{"thought":"I’m checking the live component catalog so I can choose the exact source, Anthropic LLM, and response components for the support-chat pipeline.","scratch":"Need discover live providers/lanes/config, then write pipelines/support-chat.pipe.","remove":[],"tool_calls":[{"tool":"list_components","args":{}}]}') + fenced('{"thought":"I’m unable to proceed without the live component list result in this turn, so I need the next step to inspect the available providers before creating the pipeline.","scratch":"Need discover live providers/lanes/config, then write pipelines/support-chat.pipe.","remove":[],"done":true,"answer":"I’m ready to build the support-chat pipeline, but I still need the live component catalog result to identify the exact Anthropic Claude component and chat/response wiring available in this workspace."}');

/** build-02 wave 0: the plan, then plans for later waves (13 blocks in all; 3 kept). */
const FUTURE_WAVES = [
	fenced('{"thought":"I’m getting oriented and reading the required RocketRide pipeline guides before creating the webhook-to-OpenAI summarization pipeline.","scratch":"Goal: create pipeline named summarize-text; webhook input plain text -> OpenAI model -> ~80-word summary response.","remove":[],"tool_calls":[{"tool":"list_workspace","args":{}},{"tool":"read_file","args":{"path":".rocketride/docs/ROCKETRIDE_CONCEPTS.md"}}]}'),
	fenced('{"thought":"I’m listing available engine components so I can choose the correct webhook source, OpenAI model, prompt, and response components.","scratch":"Need component names and schemas from engine before writing .pipe.","remove":["wave-1.r1","wave-1.r2"],"tool_calls":[{"tool":"list_components","args":{}}]}'),
	fenced('{"thought":"I’m extracting the component list names from the stored catalog result to identify the exact providers to describe.","scratch":"Need exact component provider names and schemas.","remove":[],"tool_calls":[{"tool":"memory.peek","args":{"key":"wave-2.r0","path":"components[0:50].name"}}]}'),
].join(' \n');

/** build-02 wave 1: one block, then a stray question mark. */
const STRAY_MARK = fenced('{"thought":"I am checking the live component catalog and schemas so the pipeline uses valid provider names, lane wiring, and configuration fields.","scratch":"Goal: create pipeline named summarize-text; webhook input plain text -> OpenAI model -> ~80-word summary response.","remove":["wave-0.r0","wave-0.r1"],"tool_calls":[{"tool":"list_components","args":{}}]}') + ' \n?';

/** build-01 wave 0: a call object lost its closing brace before `]`. */
const MALFORMED = fenced('{"thought":"I’m getting oriented in the workspace and reading the required RocketRide pipeline guides before creating the support-chat pipeline.","scratch":"Need build pipeline named support-chat for chatting with Claude Sonnet 4.6 using Anthropic key from Variables.","remove":[],"tool_calls":[{"tool":"list_workspace","args":{}},{"tool":"read_file","args":{"path":".rocketride/skills/rocketride-running-pipelines/SKILL.md"}]}');

/** The parts of a PlanReply these tests compare. */
function read(text: string): Pick<PlanReply, 'thought' | 'toolCalls' | 'done' | 'problems'> {
	const { thought, toolCalls, done, problems } = parseReply(text);
	return { thought, toolCalls, done, problems };
}

// =============================================================================
// THE QUESTION — the engine returns the reply as text
// =============================================================================

test('the plan question goes out without expectJson, and the prompt still asks for one JSON block', () => {
	const prefix: PromptPrefix = { role: CORE_PROMPT.role, instructions: CORE_PROMPT.sections };
	const q = buildWaveQuestion(prefix, [], { request: 'do it', scratch: '', results: [], notes: [], heard: [] });
	assert.equal(q.expectJson, false, 'the engine would refuse a reply with more than one block');
	assert.equal(q.cachePrefix, true);
	const loop = q.instructions.find(({ title }) => title === 'How the loop works');
	assert.match(String(loop?.text), /valid fenced JSON only/);
	assert.match(String(loop?.text), /Write exactly one fenced JSON block and nothing after it/);
});

// =============================================================================
// GPT-5.5'S REPLY SHAPES — the first block is the plan
// =============================================================================

test('a clean reply is read as written', () => {
	assert.deepEqual(read(CLEAN), {
		thought: 'I’m getting oriented and reading the required RocketRide pipeline guides before creating the support-chat pipeline.',
		toolCalls: [
			{ tool: 'list_workspace', args: {} },
			{ tool: 'read_file', args: { path: '.rocketride/skills/rocketride-building-pipelines/SKILL.md' } },
		],
		done: false,
		problems: [],
	});
});

test('a block written twice runs its calls once', () => {
	assert.deepEqual(read(DUPLICATE).toolCalls, [
		{ tool: 'memory.peek', args: { key: 'wave-2.r1', path: 'Pipe.schema.dependencies.profile.oneOf[1]' } },
		{ tool: 'search_files', args: { pattern: 'ROCKETRIDE_ANTHROPIC', path: '.rocketride', maxResults: 50 } },
	]);
});

test('a waiting block after the plan does not finish the run', () => {
	assert.deepEqual(read(WAITING), {
		thought: 'I need the exact provider names, lanes, and configuration schemas for the webhook and OpenAI model components before writing the pipeline.',
		toolCalls: [
			{ tool: 'describe_component', args: { name: 'webhook' } },
			{ tool: 'describe_component', args: { name: 'llm_openai' } },
			{ tool: 'describe_component', args: { name: 'openai' } },
		],
		done: false,
		problems: [],
	});
});

test('a waiting block fused to the closing fence does not finish the run', () => {
	assert.deepEqual(read(WAITING_FUSED), {
		thought: 'I’m checking the live component catalog so I can choose the exact source, Anthropic LLM, and response components for the support-chat pipeline.',
		toolCalls: [{ tool: 'list_components', args: {} }],
		done: false,
		problems: [],
	});
});

test('plans for later waves are ignored', () => {
	// The later blocks peek at results that do not exist yet.
	assert.deepEqual(read(FUTURE_WAVES), {
		thought: 'I’m getting oriented and reading the required RocketRide pipeline guides before creating the webhook-to-OpenAI summarization pipeline.',
		toolCalls: [
			{ tool: 'list_workspace', args: {} },
			{ tool: 'read_file', args: { path: '.rocketride/docs/ROCKETRIDE_CONCEPTS.md' } },
		],
		done: false,
		problems: [],
	});
});

test('a stray mark after the fence is ignored', () => {
	assert.deepEqual(read(STRAY_MARK), {
		thought: 'I am checking the live component catalog and schemas so the pipeline uses valid provider names, lane wiring, and configuration fields.',
		toolCalls: [{ tool: 'list_components', args: {} }],
		done: false,
		problems: [],
	});
});

test('malformed JSON is unusable, with a problem the retry note can name', () => {
	assert.deepEqual(read(MALFORMED), { thought: '', toolCalls: [], done: false, problems: ['the reply was not valid JSON'] });
});
