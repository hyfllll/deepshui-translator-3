'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_BLOCKS,
  MAX_CHARS_PER_BLOCK,
  buildReflowAiMessages,
  parseReflowAiResponse,
} = require('../main/services/reflow-ai-contract');

test('M2b 只构造已有本地文字块的文本/页码输入，跳过视觉资源', () => {
  const input = buildReflowAiMessages([{
    block_index: 4,
    block_type: 'paragraph',
    source_page_start: 2,
    source_page_end: 2,
    text_content: 'A local paragraph that remains the client-side source of truth.',
  }, {
    block_index: 5,
    block_type: 'figure',
    source_page_start: 2,
    source_page_end: 2,
    text_content: 'Local figure',
    asset: { mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
  }]);
  assert.equal(input.reviewedBlockCount, 1);
  assert.deepEqual([...input.selectedBlockIndexes], [4]);
  const payload = JSON.parse(input.messages[1].content);
  assert.deepEqual(Object.keys(payload.blocks[0]).sort(), ['blockIndex', 'blockType', 'sourcePageEnd', 'sourcePageStart', 'text']);
  assert.equal(payload.blocks[0].text, 'A local paragraph that remains the client-side source of truth.');
  assert.equal(payload.blocks.some((block) => block.blockIndex === 5), false);
  assert.doesNotMatch(input.messages[1].content, /data:|pdf|image/i);
});

test('M2b 严格忽略改写正文、未知来源和重复的模型响应', () => {
  const parsed = parseReflowAiResponse(JSON.stringify({
    version: 1,
    suggestions: [
      { blockIndex: 1, blockType: 'heading', emphasis: 'lead' },
      { blockIndex: 1, blockType: 'paragraph', emphasis: 'normal' },
      { blockIndex: 2, blockType: 'paragraph', text: 'rewritten body' },
      { blockIndex: 99, blockType: 'caption' },
      { blockIndex: 3, blockType: 'invalid' },
    ],
  }), new Set([1, 2, 3]));
  assert.deepEqual(parsed.suggestions, [{ blockIndex: 1, blockType: 'heading', emphasis: 'lead' }]);
});

test('M2b 对超长文献限额并对单块文本截断', () => {
  const blocks = Array.from({ length: MAX_BLOCKS + 40 }, (_, index) => ({
    block_index: index,
    block_type: 'paragraph',
    source_page_start: index,
    source_page_end: index,
    text_content: 'x'.repeat(MAX_CHARS_PER_BLOCK + 100),
  }));
  const input = buildReflowAiMessages(blocks);
  const payload = JSON.parse(input.messages[1].content);
  assert.ok(payload.blocks.length <= MAX_BLOCKS);
  assert.ok(payload.blocks.every((block) => block.text.length <= MAX_CHARS_PER_BLOCK));
});
