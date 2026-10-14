// 超星页面桥接工具：通过 page-bridge 在页面上下文内执行受限操作。
// 章节学习功能已移除；本文件仅保留答题模块（字体反爬解码）所需的
// readTtfList 链路。

import { callPageHook } from './page-bridge';

function safeJsonParse(text: unknown): any {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

/** 拉取字体反爬映射表 JSON */
export async function readTtfList(urls: string[]): Promise<Record<string, string> | null> {
  const res = await callPageHook({ kind: 'cxReadTtfList', urls }, 10000);
  if (!res || !res.ok) return null;
  return safeJsonParse(res.data);
}
