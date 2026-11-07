#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
daily_checkin_report.py - 媒体签到保活每日总日报推送脚本
每天 20:05 汇总播报全天签到任务的执行状态，区分成功、失败及具体报错原因。
"""

import os
import sys
import json
import sqlite3
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))
BASE_DIR = os.environ.get("PANEL_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(BASE_DIR, "data/bemby.db")

def translate_error(msg):
    if not msg:
        return "未知错误"
    msg_str = str(msg).strip()
    
    import re
    m_timeout = re.search(r"Timed out after (\d+)ms waiting for bot reply", msg_str, re.I)
    if m_timeout:
        sec = round(int(m_timeout.group(1)) / 1000)
        return f"等待机器人回复超时（{sec} 秒未响应，机器人可能维护或卡顿）"
        
    m_btn = re.search(r"Button \"(.*?)\" click timed out", msg_str, re.I)
    if m_btn:
        return f"点击按钮「{m_btn.group(1)}」无响应（回调超时）"
        
    if "Expected success indicator" in msg_str:
        return "未收到签到成功回执（可能需要图形验证码或今日已签）"
    if "No message with buttons received" in msg_str:
        return "未收到带操作按钮的机器人菜单"
    if "Button not found in bot reply" in msg_str:
        return "机器人菜单中未找到指定的签到按钮"
    if "Could not pass the Cloudflare" in msg_str:
        return "未能自动通过 Cloudflare 人机安全验证"
    if "Job cancelled" in msg_str:
        return "任务被手动取消"
    if "Account has no session" in msg_str or "unauthenticated" in msg_str:
        return "Telegram 账号未登录或 Session 失效"
    if "FloodWaitError" in msg_str:
        return "触发 Telegram 发送频率限制（FloodWait）"
        
    return msg_str.split("\n")[0][:100]

def build_daily_report():
    now_cst = datetime.now(CST)
    today_start_cst = now_cst.replace(hour=0, minute=0, second=0, microsecond=0)
    
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    c = conn.cursor()
    
    bot_token = None
    bot_target = None
    try:
        r_tok = c.execute("SELECT value FROM settings WHERE key=?", ("notify_bot_token",)).fetchone()
        if r_tok:
            bot_token = r_tok[0].strip()
        r_tar = c.execute("SELECT value FROM settings WHERE key=?", ("notify_bot_target",)).fetchone()
        if r_tar:
            bot_target = r_tar[0].strip()
    except Exception as e:
        print(f"[warn] Failed to read notify settings: {e}", file=sys.stderr)
        
    jobs = c.execute("""
        SELECT id, name, job_type, schedule_window_start, schedule_window_end, run_every_days
        FROM jobs
        WHERE enabled = 1 AND job_type IN (?, ?)
        ORDER BY name COLLATE NOCASE
    """, ("checkin", "custom")).fetchall()
    
    success_list = []
    failed_list = []
    pending_list = []
    
    for jid, name, jtype, wstart, wend, run_days in jobs:
        logs = c.execute("""
            SELECT ran_at, status, message
            FROM job_logs
            WHERE job_id = ?
            ORDER BY ran_at DESC
            LIMIT 5
        """, (jid,)).fetchall()
        
        today_log = None
        for ran_at_str, status, message in logs:
            try:
                dt = datetime.fromisoformat(ran_at_str.replace("Z", "+00:00")).astimezone(CST)
                if dt >= today_start_cst:
                    today_log = (dt, status, message)
                    break
            except Exception:
                pass
                
        if today_log:
            dt, status, msg = today_log
            time_str = dt.strftime("%H:%M")
            if status == "success":
                success_list.append((name, time_str, msg))
            elif status == "failed":
                zh_reason = translate_error(msg)
                failed_list.append((name, time_str, zh_reason))
            else:
                pending_list.append((name, "运行中"))
        else:
            w_start_str = f"{wstart//100:02d}:{wstart%100:02d}"
            w_end_str = f"{wend//100:02d}:{wend%100:02d}"
            pending_list.append((name, f"计划执行 {w_start_str}~{w_end_str}"))
            
    conn.close()
    
    total_jobs = len(jobs)
    total_success = len(success_list)
    total_failed = len(failed_list)
    total_pending = len(pending_list)
    
    weekdays = ["一", "二", "三", "四", "五", "六", "日"]
    day_str = now_cst.strftime("%Y-%m-%d")
    weekday_str = weekdays[now_cst.weekday()]
    date_str = f"{day_str}（周{weekday_str}）"
    time_str = now_cst.strftime("%H:%M")
    
    lines = [
        "📋 【媒体签到保活·每日总日报】",
        f"📅 日期：{date_str}",
        f"⏰ 统计时间：{time_str}",
        "",
        "📊 统计概览：",
        f"• 监控任务：共 {total_jobs} 个",
        f"• 签到成功：{total_success} 个 ✅",
        f"• 签到失败：{total_failed} 个 ❌",
    ]
    if total_pending > 0:
        lines.append(f"• 待执行/未触发：{total_pending} 个 ⏳")
        
    if total_failed > 0:
        lines.extend([
            "",
            "━━━━━━━━━━━━━━━━━━━━",
            f"❌ 【失败任务 ({total_failed} 个)】"
        ])
        for idx, (name, t, msg) in enumerate(failed_list, 1):
            lines.append(f"{idx}. {name} ({t})")
            lines.append(f"   原因：{msg}")
            
    if total_success > 0:
        lines.extend([
            "",
            "━━━━━━━━━━━━━━━━━━━━",
            f"✅ 【成功任务 ({total_success} 个)】"
        ])
        succ_items = [f"• {name} ({t})" for name, t, _ in success_list]
        lines.extend(succ_items)
        
    if total_pending > 0:
        lines.extend([
            "",
            "━━━━━━━━━━━━━━━━━━━━",
            f"⏳ 【待执行/未触发 ({total_pending} 个)】"
        ])
        for name, info in pending_list:
            lines.append(f"• {name} - {info}")
            
    lines.extend([
        "",
        "💡 提示：单次签到推送已静音，每日 20:05 汇总播报；观影保活保持实时推送。"
    ])
    
    report_text = "\n".join(lines)
    return report_text, bot_token, bot_target

def send_telegram_notify(token, target, message):
    if not token or not target:
        raise ValueError("Missing bot_token or bot_target")
        
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": target,
        "text": message,
        "disable_web_page_preview": True
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        res = json.load(resp)
        if not res.get("ok"):
            raise RuntimeError(f"Telegram API error: {res}")
        return res

def main():
    dry_run = "--dry-run" in sys.argv
    report_text, bot_token, bot_target = build_daily_report()
    
    now_str = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now_str}] Daily report generated:")
    print(report_text)
    print("=" * 40)
    
    if dry_run:
        print("[info] Dry run mode enabled, skipping Telegram notification.")
        return
        
    if not bot_token or not bot_target:
        print("[error] Cannot send notification: bot_token or bot_target is empty in settings!", file=sys.stderr)
        sys.exit(1)
        
    try:
        send_telegram_notify(bot_token, bot_target, report_text)
        print(f"[success] Daily report sent to Telegram {bot_target} successfully!")
    except Exception as e:
        print(f"[error] Failed to send Telegram notification: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
