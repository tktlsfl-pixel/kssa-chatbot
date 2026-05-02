/**
 * api/config.js — 챗봇이 부팅 시 호출하는 공개 설정 조회 API
 *
 * 응답: { kb, faq, settings(공개 항목만) }
 * - 비밀번호 등 민감 정보는 절대 포함하지 않음
 */

import { kv } from "@vercel/kv";
import { DEFAULT_CONFIG } from "./_defaults.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    let stored = null;
    try { stored = await kv.get("config"); } catch (e) {}
    const cfg = stored || DEFAULT_CONFIG;

    // 공개해도 되는 항목만 노출
    const publicConfig = {
      kb: {
        // 지식베이스는 시스템 프롬프트로만 사용. 클라이언트에 노출하지 않음.
      },
      faq: cfg.faq || DEFAULT_CONFIG.faq,
      settings: {
        model: cfg.settings?.model || "claude-haiku-4-5-20251001",
        languages: cfg.settings?.languages || ["ko", "en", "zh", "ja", "vi"]
      }
    };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(publicConfig);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
