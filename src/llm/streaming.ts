// ============================================================================
// SSE 流解析器 —— 只负责把 `data:` 行抽出来，不关心业务
// ============================================================================
// SSE 是逐行文本流，形如：
//   data: {json}
//   ...
//   data: [DONE]
// 要跳过的：空行、DeepSeek 的 `: keep-alive` 注释行、非 data 行。
// 依据：ticket 001（Ollama 0.32.14 已是 OpenAI wire format；DeepSeek 会发 keep-alive）。
// ============================================================================

export interface SseEvent {
  data: string
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // 网络包可能把一行拆成两半，留下一段 buffer 等下一包拼齐
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith(':')) continue // 空行 / : keep-alive
      if (!line.startsWith('data:')) continue
      yield { data: line.slice(5).trim() }
    }
  }
}
