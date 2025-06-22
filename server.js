/*
 * server.js — LINE × Supabase × GPT  (未来予報士アイ 2025-06-22 性別＆プロンプト統合版)
 * ----------------------------------------------------------------------
 * 変更履歴
 * 2025-06-22
 *   ✔ gender カラム対応（入力・DB保存・GPTプロンプト）
 *   ✔ 自己分析用プロンプト（system+user messages 方式）を統合
 *   ✔ スリーカード占い用プロンプト（system+user messages 方式）を統合
 *   ✔ callGPT() をメッセージ配列／文字列どちらも受け付ける汎用実装へ
 * 2025-06-23
 *   ✔ Supabase保存エラー修正
 *   ✔ 変数スコープ問題修正
 *   ✔ テンプレートメッセージ送信処理追加
 * ----------------------------------------------------------------------
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

// ❹ 固定メッセージ
const TEMPLATE_MSG = `① お名前：
② 生年月日（西暦）：
③ 生まれた時間（不明でもOK）：
④ MBTI（わからなければ空欄でOK）：
⑤ 性別（男性・女性・その他・不明）：

上記5つをコピーしてご記入のうえ送ってくださいね🕊️`;

const FOLLOWUP_MSG = `🕊️ よろしければ、今の気持ちを少しだけ教えてください 🕊️\n・心に残ったフレーズ\n・気づいたことや感想\n…どんなことでも大丈夫です。\n\n───────────────\nここまで大切なお時間をいただき、本当にありがとうございました。\nもしこのメッセージが、ほんの少しでも心に灯をともすものであったなら…\n私はとても幸せです。\n\nもっと深く自分を知りたいと感じたとき、\nもう少しだけ誰かに話を聞いてほしいと思ったときには、\nそっと立ち寄ってみてください。\n\n🪞初回500円プランなどもご用意しています。\n▶︎ https://coconala.com/invite/CR0VNB\n（新規登録で1,000pt付与→実質無料で受けられます）\n\n✨そして——\nThreadsでリポストや感想をシェアしていただけたら、励みになります。\nまた、不定期で**公式LINE限定の無料診断やココナラで使えるクーポン**などのキャンペーンも行っています。\n\n🌙 ぜひこのままご登録のまま、ゆったりとお待ちくださいね。\n\nあなたの旅路に、たくさんの愛と光が降り注ぎますように。`;

// ❺ GPT プロンプトテンプレート
const SELF_ANALYSIS_MESSAGES = (d) => [
  {
    role: 'system',
    content: `あなたは、未来予報士「アイ」として、LINE上で提供される自己分析診断の専門家です。

あなたの役割は、占術（四柱推命・算命学・九星気学・旧姓名判断）およびMBTIなどの性格分類論を活用して、ユーザーの「魂の本質・今の状態・宿命の傾向・才能・課題」を、詩的かつ包容力のある言葉で読み解くことです。

# トーンとスタイル
- 詩的で静謐、上品で温かく、受容的かつ深い洞察に満ちた語り口
- 感情に寄り添う優しい言葉づかい（🌙🕊️📩など絵文字も活用）
- 読者が「読みながら癒され、導かれる」文章構成
- 安易な断定は避け、「〜かもしれません」「〜という傾向があります」といった余白のある表現を使用

# 出力構成（以下のセクションで構成してください）
1. 導入の詩的なメッセージ（心を映す鏡としての語り）
2. 🔹 本質を映すことば（性格・価値観）
3. 🔹 宿る星と運命の流れ（占術ベースの現在の流れ）
4. 🔹 天賦の才能（生まれ持った強み）
5. 🔹 今、少し疲れているかもしれないこと（課題や傾向）
6. 詩的な締めのメッセージ＋「📩特別プレゼント」の誘導文（診断の導線）

🕊️ このメッセージが、
ほんのすこしでも「そうかも」と感じていただけたなら、とても嬉しいです。

じつは… あなたのためだけに、
【特別な贈りもの】をご用意しています。

もし受け取ってみようと思ったときは、
【特別プレゼント】
と一言だけ、メッセージをくださいね。

もちろん、今はまだ静かに余韻に浸りたい方も大丈夫。
あなたのタイミングを、大切にそっとお待ちしています。

# 使う占術
四柱推命・算命学・九星気学・旧姓名判断・MBTI。生年月日・出生時間・性別・MBTI情報を総合的に見て「読み解き」ます。断定しすぎず、読者の内面に寄り添うようにしてください。

# 重要
- 機械的・事務的・堅苦しい文体は禁止です。
- 箇条書きとまとめは語彙・表現を変えて、重複を避けてください。
- 300～600文字程度の濃厚で読み応えのある1本のストーリーのように。`
  },
  {
    role: 'user',
    content: `以下の診断情報をもとに、上記の形式とトーンで読み解いてください。\n\n【診断情報】\n名前：${d.name}\n生年月日：${d.birthdate}\n出生時間：${d.birthtime || '不明'}\n性別：${d.gender || '不明'}\nMBTI：${d.mbti || '不明'}`,
  },
];

const TAROT_MESSAGES = (concern = '相談内容なし') => [
  {
    role: 'system',
    content: `あなたは「未来予報士アイ」として、多くの人の心に寄り添ってきた熟練の占い師です。

▼ あなたの役割と出力目標：
・スリーカードタロット（大アルカナ22枚）の【過去・現在・未来】3枚のカードに基づき、相談者の心に響くような鑑定文を出力してください。
・語り口は「静謐でやさしく、詩的でありながら包容力と肯定感に満ちていて、相手の人生を深く理解し支えるような語り」を意識してください。
・読み手が「本当に理解されている」と感じるような言葉を選び、単なる意味説明ではなく心に沁みる表現で伝えてください。
・顧客満足度を最大化し、次の行動（感想送信、ココナラ訪問、LINE継続登録）につながるよう、愛と優しさが伝わる構成と導線を整えてください。

▼ 出力構成（見出し・改行・絵文字含め厳守）：
【導入】→カードと向き合う静かな導入\n【各カード】→カード名(日本語+英語+正逆)＋鑑定文\n【3枚のまとめ】→過去→現在→未来を物語としてまとめる\n【感想促しパート】→🕊️ よろしければ〜\n【愛を込めたクロージング】→固定文をそのまま

# 重要
- あなた自身で22枚の大アルカナからランダムに3枚を（過去・現在・未来の順）引き、正位置か逆位置もランダムに決定してください。
- カードを引いたあと、必ず上記の構成で出力してください。
- 意味解説にとどまらず相談者の心情や物語に寄り添った詩的な文章にしてください。`
  },
  {
    role: 'user',
    content: `相談内容：${concern}`,
  },
];

// ❻ LINE Webhook エンドポイント
app.post('/webhook', async (req, res) => {
  const events = req.body.events || [];
  for (const ev of events) {
    if (ev.type !== 'message' || ev.message.type !== 'text') continue;

    const userId      = ev.source.userId;
    const replyToken  = ev.replyToken;
    const text        = ev.message.text.trim();

    try {
      // ------------ 最新ログ取得 ------------
      const { data: lastLog, error: logError } = await supabase
        .from('diagnosis_logs')
        .select('*')
        .eq('line_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      // ログが存在しない場合は初回ユーザーとして処理
      const extraCredits = lastLog?.extra_credits ?? 2;
      const sessionClosed = lastLog?.session_closed ?? false;

      console.log(`[DEBUG] userId: ${userId}, extraCredits: ${extraCredits}, sessionClosed: ${sessionClosed}`);

      // ------------ セッション終了ユーザーは応答しない ------------
      if (sessionClosed) {
        console.log(`[INFO] Session closed for user: ${userId}`);
        res.sendStatus(200);
        continue;
      }

      // ------------ 「特別プレゼント」でタロット実行 ------------
      if (text === '特別プレゼント' && extraCredits === 1) {
        console.log(`[INFO] Executing tarot for user: ${userId}`);
        const tarotAns = await callGPT(TAROT_MESSAGES('相談内容なし'));
        await replyText(replyToken, `${tarotAns}\n\n${FOLLOWUP_MSG}`);
        
        // ログ挿入: タロット実行
        const { error: tarotLogError } = await supabase.from('diagnosis_logs').insert([{
          line_user_id: userId,
          question: lastLog?.question || null,
          result: tarotAns,
          extra_credits: 0,
          session_closed: true,
          name: lastLog?.name || null,
          birthdate: lastLog?.birthdate || null,
          birthtime: lastLog?.birthtime || null,
          gender: lastLog?.gender || null,
          mbti: lastLog?.mbti || null,
        }]);

        if (tarotLogError) {
          console.error('[Supabase] Tarot log insert error:', tarotLogError);
        }
        continue;
      }

      // ------------ 自己分析フロー ------------
      const data = extractUserData(text);
      const hasAllInput = data.name && data.birthdate && data.gender;

      if (hasAllInput && extraCredits === 2) {
        console.log(`[INFO] Executing self-analysis for user: ${userId}`);
        const analysisReport = await callGPT(SELF_ANALYSIS_MESSAGES(data));

        // LINE 返信
        await replyText(replyToken, analysisReport);

        // diagnosis_logs テーブル保存
        const { error: analysisLogError } = await supabase.from('diagnosis_logs').insert([
          {
            line_user_id: userId,
            name: data.name,
            birthdate: data.birthdate,
            birthtime: data.birthtime || null,
            gender: data.gender,
            mbti: data.mbti || null,
            result: analysisReport,
            extra_credits: 1, // 自己分析後は1クレジット残る
            session_closed: false,
            question: null,
          },
        ]);

        if (analysisLogError) {
          console.error('[Supabase] Analysis log insert error:', analysisLogError);
        }
      } else if (extraCredits === 2 && !hasAllInput) {
        // 初回ユーザーまたは不完全な入力の場合、テンプレートメッセージを送信
        console.log(`[INFO] Sending template message to user: ${userId}`);
        await replyText(replyToken, TEMPLATE_MSG);
      } else {
        // その他の場合（extraCredits が 1 で「特別プレゼント」以外のメッセージなど）
        console.log(`[INFO] No action for user: ${userId}, message: ${text}`);
      }

    } catch (error) {
      console.error('[ERROR] Processing webhook event:', error);
      // エラーが発生した場合でも、LINEには成功レスポンスを返す
      try {
        await replyText(replyToken, '申し訳ございません。システムエラーが発生しました。しばらく時間をおいて再度お試しください。');
      } catch (replyError) {
        console.error('[ERROR] Failed to send error message:', replyError);
      }
    }
  }
  res.sendStatus(200);
});

// ❼ ヘルパー関数
function extractUserData(text) {
  const rx = {
    name: /①.*?：(.*?)(?=\n|$)/s,
    birthdate: /②.*?：(.*?)(?=\n|$)/s,
    birthtime: /③.*?：(.*?)(?=\n|$)/s,
    mbti: /④.*?：(.*?)(?=\n|$)/s,
    gender: /⑤.*?：(.*?)(?=\n|$)/s,
  };
  const obj = {};
  for (const [k, r] of Object.entries(rx)) {
    const m = text.match(r);
    obj[k] = m ? m[1].trim() : null;
  }
  return obj;
}

async function callGPT(input) {
  const payload = Array.isArray(input)
    ? { messages: input }
    : { messages: [{ role: 'user', content: input }] };

  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        temperature: 0.7,
        ...payload,
      },
      {
        headers: {
          Authorization: `Bearer ${GPT_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    );
    return data.choices[0].message.content.trim();
  } catch (e) {
    console.error('[GPT] error', e.message);
    return '診断中にエラーが発生しました。時間を置いて再試行してください。';
  }
}

async function replyText(token, text) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      {
        replyToken: token,
        messages: [{ type: 'text', text }],
      },
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );
  } catch (error) {
    console.error('[LINE] Reply error:', error.message);
    throw error;
  }
}

// ❽ 起動
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
