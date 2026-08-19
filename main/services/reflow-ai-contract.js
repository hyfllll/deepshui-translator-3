'use strict';

const ALLOWED_BLOCK_TYPES = new Set(['heading', 'paragraph', 'list', 'code', 'caption', 'equation']);
const ALLOWED_EMPHASIS = new Set(['normal', 'lead']);
const MAX_BLOCKS = 180;
const MAX_CHARS_PER_BLOCK = 900;
const MAX_TOTAL_CHARS = 90_000;

function selectDistributed(blocks, limit) {
  if (blocks.length <= limit) return blocks;
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round(index * (blocks.length - 1) / (limit - 1));
    if (!seen.has(sourceIndex)) {
      seen.add(sourceIndex);
      selected.push(blocks[sourceIndex]);
    }
  }
  return selected;
}

function buildReflowAiMessages(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('没有可供 AI 分析的本地排版块');
  let usedChars = 0;
  const selected = selectDistributed(blocks, MAX_BLOCKS).flatMap((block) => {
    if (!ALLOWED_BLOCK_TYPES.has(block && block.block_type)) return [];
    const text = String(block && block.text_content || '').trim();
    const blockIndex = Number(block && block.block_index);
    if (!text || !Number.isSafeInteger(blockIndex) || blockIndex < 0) return [];
    const remaining = MAX_TOTAL_CHARS - usedChars;
    if (remaining <= 0) return [];
    const clippedText = text.slice(0, Math.min(MAX_CHARS_PER_BLOCK, remaining));
    usedChars += clippedText.length;
    return [{
      blockIndex,
      sourcePageStart: Number(block.source_page_start) || 0,
      sourcePageEnd: Number(block.source_page_end) || 0,
      blockType: ALLOWED_BLOCK_TYPES.has(block.block_type) ? block.block_type : 'paragraph',
      text: clippedText,
    }];
  });
  if (!selected.length) throw new Error('本地排版块不包含可分析文字');
  return {
    selectedBlockIndexes: new Set(selected.map((block) => block.blockIndex)),
    reviewedBlockCount: selected.length,
    messages: [{
      role: 'system',
      content: [
        '你是学术 PDF 阅读版面的结构分类器。',
        '只返回一个 JSON 对象，不要 Markdown、解释、代码围栏或正文。',
        '格式严格为：{"version":1,"suggestions":[{"blockIndex":0,"blockType":"heading","emphasis":"lead"}]}。',
        'blockType 只能是 heading、paragraph、list、code、caption、equation；emphasis 只能是 normal 或 lead。',
        '只能引用输入已有的 blockIndex；不得输出 text、content、reason、摘要、翻译或任何新正文。',
        '不得改变、合并、拆分、重排或删除任何来源文字；客户端会继续使用本地原文和来源页码。',
      ].join('\n'),
    }, {
      role: 'user',
      content: JSON.stringify({ schema: 'deepshui-reflow-ai-v1', blocks: selected }),
    }],
  };
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI 未返回可解析的结构建议');
  return JSON.parse(text.slice(start, end + 1));
}

function parseReflowAiResponse(raw, selectedBlockIndexes) {
  const parsed = extractJsonObject(raw);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.suggestions)) {
    throw new Error('AI 返回的结构建议格式无效');
  }
  const selected = selectedBlockIndexes instanceof Set ? selectedBlockIndexes : new Set(selectedBlockIndexes);
  const seen = new Set();
  const suggestions = [];
  for (const item of parsed.suggestions.slice(0, MAX_BLOCKS)) {
    if (!item || typeof item !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(item, 'text') || Object.prototype.hasOwnProperty.call(item, 'content')) continue;
    const blockIndex = Number(item.blockIndex);
    if (!Number.isSafeInteger(blockIndex) || !selected.has(blockIndex) || seen.has(blockIndex)) continue;
    if (!ALLOWED_BLOCK_TYPES.has(item.blockType)) continue;
    const emphasis = ALLOWED_EMPHASIS.has(item.emphasis) ? item.emphasis : 'normal';
    seen.add(blockIndex);
    suggestions.push({ blockIndex, blockType: item.blockType, emphasis });
  }
  return { suggestions };
}

module.exports = {
  ALLOWED_BLOCK_TYPES,
  MAX_BLOCKS,
  MAX_CHARS_PER_BLOCK,
  MAX_TOTAL_CHARS,
  buildReflowAiMessages,
  parseReflowAiResponse,
};
