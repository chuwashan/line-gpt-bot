/*
 * server.js — LINE × Supabase × GPT  (未来予報士アイ 2025-06-21 軽量版)
 * ------------------------------------------------------------
 * Stripe 依存を完全排除し、コードを「LINE の流れ」に沿って整理。
 * 1. ユーザー情報入力（①〜④）
 * 2. 自己分析レポート送信  → extra_credits を 1 消費
 * 3. ユーザーが「特別プレゼント」を送信
 * 4. タロット結果＋フォローアップ送信 → extra_credits を 0、session_closed=true
 * ------------------------------------------------------------
 */

// ❶ 依存モジュール & 環境変数
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const PORT   = process.env.PORT || 3000;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GPT_API_KEY  = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ❷ Supabase クライアント
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ❸ Express 初期化
const app = express();
app.use(bodyParser.json());

// ❹ フォローアップ固定文（タロット後 + クロージング）
const FOLLOWUP_MSG = `🕊️ ご感想を聞かせてください 🕊️\n\nカードを通してお伝えしたメッセージが、\n少しでも心のやわらぎにつながっていれば幸いです。\n\n・いちばん響いたフレーズ\n・気づいたこと など\nふと思い浮かんだことがあれば一言お送りくださいね。\n\n─────────\n【次のご案内】\n今回の無料特典はここまでとなりますが、\nもっと深く寄り添うサポートをご希望の方へ\nココナラ専用プランをご用意しています。\n\n▶︎ https://coconala.com/invite/CR0VNB\n(登録で1,000ptプレゼント／初回500円占いが実質無料)\n\n無理のない範囲でご検討ください。\nいつでもお待ちしています🌙\n─────────\n\n※占いが役に立ったと思っていただけたら、\nThreadsでリポストやコメントをいただけると励みになります🌸`;

// ❺ LINE Webhook エンドポイント
app.post('/webhook', async (req, res) => {
  const events = req.body.events || [];
  for (const ev of events) {
    if (ev.type !== 'message' || ev.message.type !== 'text') continue;

    const userId = ev.source.userId;
    const replyToken = ev.replyToken;
    const text = ev.message.text.trim();

    // ------------ DB からユーザー取得 or 作成 ------------
    let { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
    if (!user) {
      await supabase.from('users').insert({ id: userId, extra_credits: 2, session_closed: false });
      user = { id: userId, extra_credits: 2, session_closed: false };
    }

    // ------------ セッション終了ユーザーは応答しない ------------
    if (user.session_closed) {
      res.sendStatus(200);
      continue;
    }

    // ------------ 「特別プレゼント」トリガー ------------
    if (text === '特別プレゼント' && user.extra_credits === 1) {
      // タロット用プロンプトを生成（詳細割愛）
      const tarotPrompt = `あなたは未来予報士アイです。ユーザーの相談: ${user.concern || '相談内容なし'} を3枚タロットで…`;
      const tarotAns = await callGPT(tarotPrompt);

      await replyText(replyToken, `${tarotAns}\n\n${FOLLOWUP_MSG}`);
      await supabase.from('users').update({ extra_credits: 0, session_closed: true }).eq('id', userId);
      continue;
    }

    // ------------ 自己分析フロー ------------
    const data = extractUserData(text);
    if (data.name && data.birthdate && user.extra_credits === 2) {
      const prompt = generateSelfPrompt(data);
      const report = await callGPT(prompt);
      await replyText(replyToken, report);
      await supabase.from('users').update({ ...data, extra_credits: 1 }).eq('id', userId);
    } else if (user.extra_credits === 2) {
      await replyText(replyToken, 'まずは①お名前②生年月日③出生時間④MBTI の情報をコピペでお送りください。');
    }
  }
  res.sendStatus(200);
});

// ❻ ヘルパー関数
function extractUserData(text) {
  const rx = {
    name: /①.*?：(.*?)(?=\n|$)/s,
    birthdate: /②.*?：(.*?)(?=\n|$)/s,
    birthtime: /③.*?：(.*?)(?=\n|$)/s,
    mbti: /④.*?：(.*)/s,
  };
  const obj = {};
  for (const [k, r] of Object.entries(rx)) {
    const m = text.match(r);
    obj[k] = m ? m[1].trim() : null;
  }
  return obj;
}

function generateSelfPrompt(d) {
  return `あなたは未来予報士アイです。算命学・四柱推命・九星気学・MBTI を総合し、以下の情報から無料セルフリーディング結果を作成してください。Markdown 記号は使わず、全角記号で見出しを入れます。\n\n【入力】\n名前：${d.name}\n生年月日：${d.birthdate}\n出生時間：${d.birthtime || '不明'}\nMBTI：${d.mbti || '不明'}\n\n【出力フォーマット】\n🔎無料セルフリーディング結果🔎\n未来予報士アイです。いただいた情報を分析し、あなたを多面的に読み解きました。\n\n――――――――――――――――\n◆性格キーワード\n・(3行)\n\n性格まとめ：150文字以内\n\n◆強み\n・(3行)\n\n強みまとめ：150文字以内\n\n◆いま抱えやすい課題\n・(3行)\n\n課題まとめ：150文字以内\n\n――――――――――――――――\n総合まとめ：300文字以内\n\n――――――――――――――――\nここまで読んでくださって、ほんとうにありがとうございます。少しでも「そうかも」と感じていただけたなら、私はとても嬉しいです。\n\nじつは……あなたへの【特別プレゼント】をひそかに用意しました。受け取ってみようかな、と思ったときに\n\n　特別プレゼント\n\nと一言だけ送ってくださいね。もちろん、今はゆっくり浸りたい方はそのままでも大丈夫。あなたのタイミングを大切に、そっとお待ちしています。`;
}

async function callGPT(prompt) {
  try {
    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    }, {
      headers: {
        Authorization: `Bearer ${GPT_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    return data.choices[0].message.content.trim();
  } catch (e) {
    console.error('[GPT] error', e.message);
    return '診断中にエラーが発生しました。時間を置いて再試行してください。';
  }
}

async function replyText(token, text) {
  await axios.post('https://api.line.me/v2/bot/message/reply', {
    replyToken: token,
    messages: [{ type: 'text', text }],
  }, {
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// ❼ 起動
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
