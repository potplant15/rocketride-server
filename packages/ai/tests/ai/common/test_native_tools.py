# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Native tool calling: the name map, the stop table, and the LangChain codec.

The codec is checked by what the provider would receive: each turn is encoded, then
LangChain's own request builder turns it into the wire payload, which is what the
assertions read.
"""

from __future__ import annotations

import re

import pytest

from ai.common.llm_tools import (
    ToolNames,
    from_langchain,
    model_origin,
    provider_tool_name,
    stop_reason,
    to_langchain,
    tool_specs,
)
from ai.common.schema import AssistantMessage, Question, ReasoningBlock, TextBlock, ToolCallBlock, UserMessage

langchain_anthropic = pytest.importorskip('langchain_anthropic')
from langchain_core.messages import AIMessage  # noqa: E402

PROVIDER_NAME = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
SIG = 'EqQBCkYIBxgCKkBsig=='


def _anthropic():
    return langchain_anthropic.ChatAnthropic(model='claude-sonnet-4-5', api_key='sk-ant-test', max_tokens=1024)


def _payload(llm, question: Question, cache: bool = False):
    """The request body LangChain would send for this turn."""
    origin = model_origin(llm)
    messages = to_langchain(question.getSystemPrompt(), question.getTurnMessages(), origin, cache)
    bound = llm.bind_tools(tool_specs(question.tools))
    return bound.bound._get_request_payload(messages, **bound.kwargs)


def _loop_question(llm) -> Question:
    """A wave after one call: the assistant thought, called two tools (one with bad args), and got results."""
    q = Question(
        role='You are the Rocket agent.',
        tools=[{'name': 'tool_github_1.create_issue'}, {'name': 'memory.peek'}],
        messages=[UserMessage(content='File an issue.')],
    )
    q.addMessage(
        AssistantMessage(
            content=[
                ReasoningBlock(
                    text='I should file it.',
                    state={
                        'origin': model_origin(llm),
                        'block': {'type': 'thinking', 'thinking': 'I should file it.', 'signature': SIG},
                    },
                ),
                TextBlock(text='Filing it.'),
                ToolCallBlock(id='call_1', name='tool_github_1.create_issue', args={'title': 'Flaky'}),
                ToolCallBlock(id='call_2', name='memory.peek', args='{"key": '),
            ]
        )
    )
    q.addToolResult('call_1', '#42')
    q.addToolResult('call_2', 'bad arguments', isError=True)
    return q


def test_provider_names_are_legal_distinct_and_map_back():
    names = [
        'navigate',
        'memory.peek',
        'tool_github_1.create_issue',
        'a__b',
        'a_.b',
        'a._b',
        'x y',
        'é',
        'm.' + 'n' * 70,
    ]
    tools = [{'name': n} for n in names]
    q = Question(tools=tools, messages=[UserMessage(content='hi')])
    table = ToolNames.build(q.tools, q.messages)

    provider = [provider_tool_name(n) for n in names]
    assert all(PROVIDER_NAME.match(p) for p in provider)
    assert len(set(provider)) == len(names)
    assert [table.caller(p) for p in provider] == names
    assert provider[:3] == ['navigate', 'memory__peek', 'tool_github_1__create_issue']
    assert table.caller('memory.peek') == 'memory.peek'


@pytest.mark.parametrize(
    'raw, has_calls, expected',
    [
        ('end_turn', False, 'end_turn'),
        ('tool_use', True, 'tool_use'),
        ('tool_calls', True, 'tool_use'),
        ('stop', True, 'tool_use'),
        ('stop', False, 'end_turn'),
        ('length', False, 'max_tokens'),
        ('max_output_tokens', False, 'max_tokens'),
        ('content_filter', False, 'refusal'),
        ('stop_sequence', False, 'stop_sequence'),
        ('tool_use', False, 'end_turn'),
        (None, False, 'end_turn'),
    ],
)
def test_stop_reasons_normalize_and_agree_with_the_calls(raw, has_calls, expected):
    assert stop_reason(raw, has_calls) == expected


def test_anthropic_wire_carries_signed_thinking_calls_results_and_cache_marks():
    llm = _anthropic()
    q = _loop_question(llm)
    q.addContext('The page is /home.')

    payload = _payload(llm, q, cache=True)

    assert payload['system'] == [{'type': 'text', 'text': q.getSystemPrompt(), 'cache_control': {'type': 'ephemeral'}}]
    assert [t['name'] for t in payload['tools']] == ['tool_github_1__create_issue', 'memory__peek']
    user, assistant, results = payload['messages']
    assert user == {'role': 'user', 'content': [{'type': 'text', 'text': 'File an issue.'}]}
    assert assistant['content'][0] == {'type': 'thinking', 'thinking': 'I should file it.', 'signature': SIG}
    assert [(b['type'], b.get('id'), b.get('name')) for b in assistant['content'][1:]] == [
        ('text', None, None),
        ('tool_use', 'call_1', 'tool_github_1__create_issue'),
        ('tool_use', 'call_2', 'memory__peek'),
    ]
    kinds = [(b['type'], b.get('tool_use_id'), b.get('is_error')) for b in results['content']]
    assert kinds == [('tool_result', 'call_1', False), ('tool_result', 'call_2', True), ('text', None, None)]
    assert 'The page is /home.' in results['content'][-1]['text']
    assert results['content'][-1]['cache_control'] == {'type': 'ephemeral'}
    assert sum('cache_control' in b for m in payload['messages'] for b in m['content']) == 1


def test_reasoning_from_another_model_is_not_sent():
    llm = _anthropic()
    q = _loop_question(llm)
    q.messages[1].content[0].state['origin'] = 'SomeOtherChatModel'

    assistant = _payload(llm, q)['messages'][1]

    assert [b['type'] for b in assistant['content']] == ['text', 'tool_use', 'tool_use']


def test_openai_wire_maps_names_and_replays_bad_arguments_as_sent():
    langchain_openai = pytest.importorskip('langchain_openai')
    llm = langchain_openai.ChatOpenAI(model='gpt-4.1', api_key='sk-test')
    q = _loop_question(_anthropic())

    payload = _payload(llm, q)

    assistant = payload['messages'][2]
    assert [(c['id'], c['function']['name'], c['function']['arguments']) for c in assistant['tool_calls']] == [
        ('call_1', 'tool_github_1__create_issue', '{"title": "Flaky"}'),
        ('call_2', 'memory__peek', '{"key": '),
    ]
    assert 'thinking' not in str(assistant['content'])
    assert [(m['role'], m.get('tool_call_id')) for m in payload['messages'][3:]] == [
        ('tool', 'call_1'),
        ('tool', 'call_2'),
    ]


def test_a_model_message_decodes_with_caller_names_and_its_reasoning_kept_whole():
    q = _loop_question(_anthropic())
    names = ToolNames.build(q.tools, q.messages)
    thinking = {'type': 'thinking', 'thinking': 'Label it.', 'signature': SIG, 'index': 0}
    reply = AIMessage(
        content=[thinking, {'type': 'text', 'text': 'Labelling.'}],
        tool_calls=[{'id': 'call_3', 'name': 'tool_github_1__create_issue', 'args': {'labels': ['bug']}}],
        invalid_tool_calls=[{'id': 'call_4', 'name': 'memory__peek', 'args': '{oops', 'error': 'bad json'}],
        response_metadata={'stop_reason': 'tool_use'},
    )

    message, stop = from_langchain(reply, names, 'ChatAnthropic')

    assert stop == 'tool_use'
    reasoning, text, call, bad = message.content
    assert (reasoning.text, reasoning.state) == ('Label it.', {'origin': 'ChatAnthropic', 'block': thinking})
    assert text.text == 'Labelling.'
    assert (call.id, call.name, call.args) == ('call_3', 'tool_github_1.create_issue', {'labels': ['bug']})
    assert (bad.id, bad.name, bad.args) == ('call_4', 'memory.peek', '{oops')


def test_think_tags_in_plain_text_become_reasoning_not_text():
    message, stop = from_langchain(AIMessage(content='<think>plan</think>Done.'), ToolNames({}), 'ChatOpenAI')

    assert [(type(b).__name__, getattr(b, 'text', None)) for b in message.content] == [
        ('ReasoningBlock', 'plan'),
        ('TextBlock', 'Done.'),
    ]
    assert stop == 'end_turn'
