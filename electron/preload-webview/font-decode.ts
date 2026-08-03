// 超星字体反爬解码：选项文本用自定义字体渲染，textContent 取到的是 PUA 区私用码位，
// 必须通过字体映射表(cxsecret.json 等)还原成真实字符。
// 映射表经 page-bridge 在页面上下文内 fetch（避免 preload 隔离世界的 CORS 限制）。

import { readTtfList } from './chaoxing-chapter-api';

const TTF_URLS = [
  'https://www.forestpolice.org/ttf/2.0/table.json',
  'https://cdn.ocsjs.com/resources/font/table.json',
  'https://static.muketool.com/scripts/cx/v2/fonts/cxsecret.json'
];

let fontMapCache: Record<string, string> | null | undefined;
let loadingPromise: Promise<Record<string, string> | null> | null = null;

/** 异步加载字体映射表（带缓存）；加载失败返回 null，调用方按原文本处理 */
export async function loadFontMap(): Promise<Record<string, string> | null> {
  if (fontMapCache !== undefined) return fontMapCache;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const map = await readTtfList(TTF_URLS);
    fontMapCache = map && typeof map === 'object' ? map as Record<string, string> : null;
    return fontMapCache;
  })();
  return loadingPromise;
}

/**
 * 用字体映射表还原文本：把 PUA 码位( 等)替换为真实字符。
 * 映射表的 key 可能是 "\\ue1f1" 或 "e1f1" 或码点字符本身，统一兼容。
 */
export function decodeFontText(text: string, map: Record<string, string> | null): string {
  if (!map || !text) return text;
  let result = String(text);
  // 1. 直接按码点字符替换（key 是 "" 形式或真实 PUA 字符）
  for (const key of Object.keys(map)) {
    // 把 "" 转成真实字符
    let glyph: string;
    if (/^\\u[0-9a-fA-F]{4,5}$/.test(key)) {
      glyph = String.fromCharCode(parseInt(key.slice(2), 16));
    } else if (/^[0-9a-fA-F]{4,5}$/.test(key)) {
      glyph = String.fromCharCode(parseInt(key, 16));
    } else {
      glyph = key;
    }
    if (glyph && result.indexOf(glyph) !== -1) {
      result = result.split(glyph).join(map[key]);
    }
  }
  return result;
}

/** 同步解码：若映射表已加载则还原，否则原样返回（用于无法 await 的路径） */
export function decodeFontTextSync(text: string): string {
  return decodeFontText(text, fontMapCache ?? null);
}

/** 是否已加载字体映射表（用于判断是否需要等待异步加载） */
export function hasFontMap(): boolean {
  return fontMapCache != null;
}
