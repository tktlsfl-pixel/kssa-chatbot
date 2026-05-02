/**
 * api/admin.js — 관리자 통합 API (한 엔드포인트로 여러 액션 처리)
 *
 * 환경변수:
 *   ADMIN_PASSWORD   관리자 비밀번호 (필수, 평문 저장하지 말고 Vercel Env Var 사용)
 *
 * 인증: 모든 요청에 'x-admin-password' 헤더 필요
 *
 * 액션 (POST body 또는 query string의 action):
 *   GET  ?action=summary     → 통계 + 최근 로그 요약
 *   GET  ?action=logs        → 채팅 로그 목록 (최대 1000건)
 *   GET  ?action=config      → 전체 설정 (KB 포함)
 *   GET  ?action=daily       → 일자별 카운트 (최근 30일)
 *   POST action=login        → 비밀번호 검증
 *   POST action=save_kb      → 지식베이스 업데이트
 *   POST action=save_faq     → 자주 묻는 질문 업데이트
 *   POST action=save_settings→ 설정(모델 등) 업데이트
 *   POST action=clear_logs   → 모든 로그 삭제
 *   POST action=reset        → 기본값으로 초기화
 */

import { kv } from "@vercel/kv";
import { DEFAULT_CONFIG } from "./_defaults.js";

export const config = { runtime: "nodejs" };

function authorize(req) {
  const provided = req.headers["x-admin-password"];
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return { ok: false, error: "서버 설정 오류: ADMIN_PASSWORD 환경변수 미설정" };
  if (provided !== expected) return { ok: false, error: "비밀번호가 올바르지 않습니다." };
  return { ok: true };
}

async function getStoredConfig() {
  try {
    const stored = await kv.get("config");
    return stored || JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // 인증
  const auth = authorize(req);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  const action = (req.query?.action) || (req.body?.action);
  if (!action) return res.status(400).json({ error: "action 파라미터가 필요합니다." });

  try {
    if (req.method === "GET") {
      switch (action) {
        case "summary": {
          const stats = (await kv.hgetall("stats")) || {};
          const recent = (await kv.lrange("logs", 0, 9)) || [];
          return res.status(200).json({
            stats: stats,
            recent_logs: recent.map(safeParse)
          });
        }
        case "logs": {
          const limit = Math.min(parseInt(req.query.limit || "200", 10), 1000);
          const raw = (await kv.lrange("logs", 0, limit - 1)) || [];
          return res.status(200).json({ logs: raw.map(safeParse), count: raw.length });
        }
        case "config": {
          const cfg = await getStoredConfig();
          return res.status(200).json({ config: cfg });
        }
        case "daily": {
          const days = Math.min(parseInt(req.query.days || "30", 10), 90);
          const today = new Date();
          const out = [];
          for (let i = days - 1; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            const ds = d.toISOString().slice(0, 10);
            const v = await kv.hget(`daily:${ds}`, "total");
            out.push({ date: ds, count: parseInt(v || "0", 10) });
          }
          return res.status(200).json({ daily: out });
        }
        default:
          return res.status(400).json({ error: "알 수 없는 GET action" });
      }
    }

    if (req.method === "POST") {
      const body = req.body || {};
      switch (action) {
        case "login": {
          // 인증 통과 자체가 성공 의미
          return res.status(200).json({ ok: true });
        }
        case "save_kb": {
          const cfg = await getStoredConfig();
          if (typeof body.consumer === "string") cfg.kb.consumer = body.consumer;
          if (typeof body.member === "string") cfg.kb.member = body.member;
          cfg.updated_at = new Date().toISOString();
          await kv.set("config", cfg);
          return res.status(200).json({ ok: true });
        }
        case "save_faq": {
          const cfg = await getStoredConfig();
          if (body.faq && typeof body.faq === "object") {
            cfg.faq = body.faq;
          }
          cfg.updated_at = new Date().toISOString();
          await kv.set("config", cfg);
          return res.status(200).json({ ok: true });
        }
        case "save_settings": {
          const cfg = await getStoredConfig();
          cfg.settings = { ...(cfg.settings || {}), ...(body.settings || {}) };
          cfg.updated_at = new Date().toISOString();
          await kv.set("config", cfg);
          return res.status(200).json({ ok: true });
        }
        case "clear_logs": {
          await kv.del("logs");
          return res.status(200).json({ ok: true });
        }
        case "reset": {
          await kv.set("config", JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
          return res.status(200).json({ ok: true });
        }
        default:
          return res.status(400).json({ error: "알 수 없는 POST action" });
      }
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("admin error:", err);
    return res.status(500).json({ error: err.message });
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}
