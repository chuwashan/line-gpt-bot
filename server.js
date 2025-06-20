/*
 * server.js  – LINE × Supabase × GPT  (1-table, Stripeなし軽量版)
 * ------------------------------------------------------------
 * 1. 自己分析：extra_credits 2 → 1
 * 2. 「特別プレゼント」：extra_credits 1 → 0 ＆ session_closed=true
 * 3. 以降は自動応答せず（感想などは手動対応）
 * モデルは環境変数 OPENAI_MODEL（例 gpt-4o-mini）で可変。
 * ------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

/* 環境変数 */
const PORT                     = process.env.PORT || 3000;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GPT_API_KEY              = process.env.OPENAI_API_KEY;
const OPENAI_MODEL             = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE    = process.env.SUPABASE_SERVICE_ROLE_KEY;

/* Supabase */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

/* Express */
const app = express();
app.use(bodyParser.json());

/* フォローアップ文 */
const FOLLOWUP_MSG = `🕊️ ご感想を聞かせてください 🕊️

カードを通してお伝えしたメッセージが、少しでも心のやわらぎにつながっていれば幸いです。

・いちばん響いたフレーズ
・気づいたこと など
ふと思い浮かんだことがあれば一言お送りくださいね。

─────────
【次のご案内】
今回の無料特典はここまでとなりますが、
もっと深く寄り添うサポートをご希望の方へ
ココナラ専用プランをご用意しています。

▶︎ https://coconala.com/invite/CR0VNB
(登録で1,000ptプレゼント／初回500円占いが実質無料)

無理のない範囲でご検討ください。
いつでもお待ちしています🌙
─────────

※占いが役に立ったと思っていただけたら、
Threadsでリポストやコメントをいただけると励みになります🌸`;

/* Webhook */
app.post('/webhook', async (req, res) => {
  const events = req.body.events || [];
  for (const ev of events) {
    if (ev.type !== 'message' || ev.message.type !== 'text') continue;

    const userId     = ev.source.userId;
    const replyToken = ev.replyToken;
    const text       = ev.message.text.trim();

    /* 行取得 or 新規挿入 (extra_credits=2) */
    let { data: row } = await supabase
      .from('diagnosis_logs')
      .select('*')
      .eq('id', userId)
      .single();

    if (!row) {
      await supabase.from('diagnosis_logs')
        .insert({ id: userId, extra_credits: 2, session_closed: false });
      row = { id: userId, extra_credits: 2, session_closed: false };
    }

    /* セッション終了なら無応答 */
    if (row.session_closed) continue;

    /* ───── 特別プレゼント：タロット ───── */
    if (text === '特別プレゼント' && row.extra_credits === 1) {
      const tarotPrompt = `あなたは未来予報士アイです。ユーザーの相談: 「${row.question || '相談内容なし'}」\
 を3枚タロットで過去・現在・未来に読み解き、日本語で800字以内で回答してください。Markdownは使わず、優しい語り口で。`;
      const tarot = await callGPT(tarotPrompt);

      await replyText(replyToken, `${tarot}\n\n${FOLLOWUP_MSG}`);

      await supabase
        .from('diagnosis_logs')
        .update({ result: tarot, extra_credits: 0, session_closed: true })
        .eq('id', userId);

      continue;
    }

    /* ───── 自己分析フェーズ ───── */
    if (row.extra_credits === 2) {
      const data = extractUserData(text);

      if (data.name && data.birthdate) {
        const prompt  = generateSelfPrompt(data);
        const report  = await callGPT(prompt);

        await replyText(replyToken, report);

        await supabase.from('diagnosis_logs').update({
          ...data,
          result: report,
          extra_credits: 1
        }).eq('id', userId);

      } else {
        /* 入力案内（1 通だけ） */
        await replyText(
          replyToken,
          'まずは①お名前②生年月日③出生時間④MBTI の情報をコピペでお送りください。'
        );
      }
    }
  }
  res.sendStatus(200);
});

/* ヘルパー群 */
function extractUserData(txt) {
  const rx = {
    name      : /①.*?：(.*?)(?=\n|$)/s,
    birthdate : /②.*?：(.*?)(?=\n|$)/s,
    birthtime : /③.*?：(.*?)(?=\n|$)/s,
    mbti      : /④.*?：(.*)/s,
    question  : /相談.*?：(.*)/s
  };
  const out = {};
  for (const [k, r] of Object.entries(rx)) {
    const m = txt.match(r);
    if (m) out[k] = m[1].trim();
  }
  return out;
}

function generateSelfPrompt(d) {
  return `あなたは未来予報士アイです。算命学・四柱推命・九星気学・MBTI を総合し、以下の情報から自己分析レポートを作成してください。Markdown記号は使わず、日本語で出力。\n\
名前:${d.name}\n生年月日:${d.birthdate}\n出生時間:${d.birthtime || '不明'}\nMBTI:${d.mbti || '不明'}\n\n\
🔎無料セルフリーディング結果🔎\n未来予報士アイです。いただいた情報を分析し、あなたを多面的に読み解きました。\n\
――――――――――――――――\n◆性格キーワード\n・(3行)\n\n性格まとめ：150文字以内\n\n◆強み\n・(3行)\n\n強みまとめ：150文字以内\n\n◆いま抱えやすい課題\n・(3行)\n\n課題まとめ：150文字以内\n\n――――――――――――――――\n総合まとめ：300文字以内\n\n――――――――――――――――\nここまで読んでくださって、ほんとうにありがとうございます。少しでも「そうかも」と感じていただけたなら私はとても嬉しいです。\n\
じつは……あなたへの【特別プレゼント】をひそかに用意しました。受け取ってみようかなと思ったときに\n\n　特別プレゼント\n\nと一言だけ送ってくださいね。もちろん今はゆっくり浸りたい方はそのままでも大丈夫。あなたのタイミングを大切にそっとお待ちしています。`;
}

async function callGPT(prompt) {
  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${GPT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return data.choices[0].message.content.trim();
  } catch (e) {
    console.error('[GPT] error', e.message);
    return '診断中にエラーが発生しました。時間を置いて再試行してください。';
  }
}

async function replyText(token, text) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    { replyToken: token, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
  );
}

/* 起動 */
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
