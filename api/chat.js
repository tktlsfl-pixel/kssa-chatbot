/**
 * api/chat.js — Claude API 프록시
 *
 * 환경변수 (Vercel 대시보드 → Settings → Environment Variables 에 등록)
 *   ANTHROPIC_API_KEY  Anthropic Console에서 발급한 sk-ant-... 키 (필수)
 *
 * Vercel KV (Storage 탭에서 KV 데이터베이스 생성 후 자동 연결됨)
 *   - 지식베이스, FAQ, 설정을 'config' 키로 저장
 *   - 채팅 로그를 'logs' 리스트(최근 1000건)에 적재
 *   - 통계 카운터를 'stats' 해시에 누적
 */

import Anthropic from "@anthropic-ai/sdk";
import { kv } from "@vercel/kv";
import { DEFAULT_CONFIG, LANG_INSTRUCTIONS } from "./_defaults.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages, mode, lang } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages가 필요합니다." });
    }
    const safeMode = (mode === "member") ? "member" : "consumer";
    const safeLang = LANG_INSTRUCTIONS[lang] ? lang : "ko";

    // 1) KV에서 지식베이스/설정 로드 (없으면 기본값)
    let stored = null;
    try { stored = await kv.get("config"); } catch (e) { /* KV 미연결 시 기본값 사용 */ }
    const cfg = stored || DEFAULT_CONFIG;
    const kb = cfg.kb?.[safeMode] || DEFAULT_CONFIG.kb[safeMode];
    const model = cfg.settings?.model || "claude-haiku-4-5-20251001";
    const maxTokens = cfg.settings?.maxTokens || 1024;

    // 2) 시스템 프롬프트 구성
    const systemPrompt = kb + "\n\n" + LANG_INSTRUCTIONS[safeLang];

    // 3) Anthropic 호출
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: "서버 설정 오류: ANTHROPIC_API_KEY 환경변수가 비어 있습니다. Vercel 대시보드에서 등록하세요."
      });
    }
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // 직전 N턴만 컨텍스트로 전달
    const turns = cfg.settings?.historyTurns || 5;
    const recent = messages.slice(-turns * 2);

    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: recent
    });

    const reply = response.content?.[0]?.text || "";
    const lastUserMsg = recent[recent.length - 1]?.content || "";

    // 4) 로그·통계 (KV가 연결되지 않았으면 silently skip)
    try {
      const logEntry = {
        ts: new Date().toISOString(),
        mode: safeMode,
        lang: safeLang,
        model,
        question: String(lastUserMsg).slice(0, 500),
        answer_preview: reply.slice(0, 300),
        answer_length: reply.length,
        input_tokens: response.usage?.input_tokens || 0,
        output_tokens: response.usage?.output_tokens || 0
      };
      await kv.lpush("logs", JSON.stringify(logEntry));
      await kv.ltrim("logs", 0, 999); // 최근 1000건만 보관

      // 통계 누적
      await kv.hincrby("stats", "total", 1);
      await kv.hincrby("stats", `mode:${safeMode}`, 1);
      await kv.hincrby("stats", `lang:${safeLang}`, 1);
      await kv.hincrby("stats", `tokens:input`, response.usage?.input_tokens || 0);
      await kv.hincrby("stats", `tokens:output`, response.usage?.output_tokens || 0);

      // 일자별 카운트 (YYYY-MM-DD)
      const today = new Date().toISOString().slice(0, 10);
      await kv.hincrby(`daily:${today}`, "total", 1);
      await kv.expire(`daily:${today}`, 60 * 60 * 24 * 90); // 90일 보관
    } catch (e) {
      console.error("KV log error:", e.message);
    }

    return res.status(200).json({ reply, model });
  } catch (err) {
    console.error("chat handler error:", err);
    const status = err?.status || 500;
    const message = err?.message || "서버 오류가 발생했습니다.";
    return res.status(status).json({ error: message });
  }
}
