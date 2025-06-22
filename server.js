/*
 * server.js — LINE × Supabase × GPT  (セキュリティ・監視強化版)
 * ----------------------------------------------------------------------
 * 追加機能
 * ✔ LINE署名検証でなりすまし防止
 * ✔ 構造化ログによる詳細な動作記録
 * ✔ エラー監視とアラート機能
 * ✔ レート制限による不正利用防止
 * ✔ セキュリティヘッダーとヘルスチェック
 * ----------------------------------------------------------------------
 */

// ❶ 依存モジュール & 環境変数
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const winston = require('winston');
require('dotenv').config();

const PORT   = process.env.PORT || 3000;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET; // 🔒 署名検証用
const GPT_API_KEY  = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL; // 🚨 アラート用（任意）

// ❷ ログ設定
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'line-ai-bot' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// ❃ Supabase クライアント
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ❹ Express 初期化とセキュリティ設定
const app = express();

// 🔒 セキュリティヘッダー
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Raw bodyが必要（署名検証のため）
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

// ❺ レート制限（メモリ内実装）
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1分
const RATE_LIMIT_MAX = 10; // 1分間に10回まで

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = rateLimit.get(userId) || [];
  const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (recentRequests.length >= RATE_LIMIT_MAX) {
    logger.warn('Rate limit exceeded', { userId, requestCount: recentRequests.length });
    return false;
  }
  
  recentRequests.push(now);
  rateLimit.set(userId, recentRequests);
  return true;
}

// ❻ LINE署名検証
function verifyLineSignature(body, signature) {
  if (!LINE_CHANNEL_SECRET) {
    logger.error('LINE_CHANNEL_SECRET not configured');
    return false;
  }
  
  const hash = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  
  const isValid = hash === signature;
  
  if (!isValid) {
    logger.warn('Invalid LINE signature', { 
      expected: hash.substring(0, 10) + '...', 
      received: signature?.substring(0, 10) + '...' 
    });
  }
  
  return isValid;
}

// ❼ エラー通知機能
async function notifyError(error, context = {}) {
  const errorInfo = {
    timestamp: new Date().toISOString(),
    error: error.message,
    stack: error.stack,
    context
  };
  
  logger.error('Critical error occurred', errorInfo);
  
  // Slack通知（設定されている場合）
  if (SLACK_WEBHOOK_URL) {
    try {
      await axios.post(SLACK_WEBHOOK_URL, {
        text: `🚨 LINE Bot Error Alert`,
        attachments: [{
          color: 'danger',
          fields: [
            { title: 'Error', value: error.message, short: false },
            { title: 'Context', value: JSON.stringify(context, null, 2), short: false }
          ]
        }]
      });
    } catch (slackError) {
      logger.error('Failed to send Slack notification', { error: slackError.message });
    }
  }
}

// ❽ 固定メッセージ
const TEMPLATE_MSG = `① お名前：
② 生年月日（西暦）：
③ 生まれた時間（不明でもOK）：
④ MBTI（わからなければ空欄でOK）：
⑤ 性別（男性・女性・その他・不明）：

上記5つをコピーしてご記入のうえ送ってくださいね🕊️`;

const FOLLOWUP_MSG = `🕊️ よろしければ、今の気持ちを少しだけ教えてください 🕊️\n・心に残ったフレーズ\n・気づいたことや感想\n…どんなことでも大丈夫です。\n\n───────────────\nここまで大切なお時間をいただき、本当にありがとうございました。\nもしこのメッセージが、ほんの少しでも心に灯をともすものであったなら…\n私はとても幸せです。\n\nもっと深く自分を知りたいと感じたとき、\nもう少しだけ誰かに話を聞いてほしいと思ったときには、\nそっと立ち寄ってみてください。\n\n🪞初回500円プランなどもご用意しています。\n▶︎ https://coconala.com/invite/CR0VNB\n（新規登録で1,000pt付与→実質無料で受けられます）\n\n✨そして——\nThreadsでリポストや感想をシェアしていただけたら、励みになります。\nまた、不定期で**公式LINE限定の無料診断やココナラで使えるクーポン**などのキャンペーンも行っています。\n\n🌙 ぜひこのままご登録のまま、ゆったりとお待ちくださいね。\n\nあなたの旅路に、たくさんの愛と光が降り注ぎますように。`;

// ❾ GPT プロンプトテンプレート
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

// ❿ ヘルスチェックエンドポイント
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ⓫ LINE Webhook エンドポイント（セキュリティ強化版）
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  let requestId = crypto.randomUUID();
  
  try {
    // 🔒 署名検証
    const signature = req.headers['x-line-signature'];
    if (!verifyLineSignature(req.body, signature)) {
      logger.warn('Unauthorized webhook request', { 
        requestId,
        ip: req.ip,
        userAgent: req.headers['user-agent']
      });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body = JSON.parse(req.body);
    const events = body.events || [];
    
    logger.info('Webhook request received', {
      requestId,
      eventCount: events.length,
      destination: body.destination
    });

    for (const ev of events) {
      if (ev.type !== 'message' || ev.message.type !== 'text') {
        logger.debug('Skipping non-text message', { requestId, eventType: ev.type });
        continue;
      }

      const userId = ev.source.userId;
      const replyToken = ev.replyToken;
      const text = ev.message.text.trim();

      // 📊 ユーザーアクション記録
      logger.info('User message received', {
        requestId,
        userId: userId.substring(0, 8) + '***', // プライバシー保護
        messageLength: text.length,
        messagePreview: text.substring(0, 20) + (text.length > 20 ? '...' : '')
      });

      // 🚫 レート制限チェック
      if (!checkRateLimit(userId)) {
        logger.warn('Rate limit exceeded for user', { requestId, userId });
        await replyText(replyToken, '申し訳ございません。少しお時間をおいてから再度お試しください。');
        continue;
      }

      // 📋 ユーザー状態取得
      const { data: lastLog, error: logError } = await supabase
        .from('diagnosis_logs')
        .select('extra_credits, session_closed, question, name, birthdate, birthtime, gender, mbti')
        .eq('line_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (logError && logError.code !== 'PGRST116') { // PGRST116 = No rows found
        logger.error('Database query error', { requestId, error: logError, userId });
        await notifyError(new Error('Database query failed'), { requestId, userId, operation: 'getUserState' });
        await replyText(replyToken, 'システムエラーが発生しました。しばらく時間をおいて再度お試しください。');
        continue;
      }

      const extraCredits = lastLog?.extra_credits ?? 2;
      const sessionClosed = lastLog?.session_closed ?? false;

      logger.info('User state retrieved', {
        requestId,
        userId: userId.substring(0, 8) + '***',
        extraCredits,
        sessionClosed
      });

      // セッション終了チェック
      if (sessionClosed) {
        logger.info('Session closed user ignored', { requestId, userId });
        continue;
      }

      // 🔮 「特別プレゼント」でタロット実行
      if (text === '特別プレゼント' && extraCredits === 1) {
        logger.info('Executing tarot reading', { requestId, userId });
        
        const tarotStartTime = Date.now();
        const tarotAns = await callGPT(TAROT_MESSAGES('相談内容なし'), requestId);
        const tarotDuration = Date.now() - tarotStartTime;
        
        logger.info('Tarot reading completed', { 
          requestId, 
          userId,
          duration: tarotDuration,
          responseLength: tarotAns.length 
        });

        await replyText(replyToken, `${tarotAns}\n\n${FOLLOWUP_MSG}`);
        
        // DB保存
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
          logger.error('Tarot log insert error', { requestId, error: tarotLogError });
          await notifyError(tarotLogError, { requestId, userId, operation: 'tarotLogInsert' });
        }
        continue;
      }

      // 🧠 自己分析フロー
      const data = extractUserData(text);
      const hasAllInput = data.name && data.birthdate && data.gender;

      if (hasAllInput && extraCredits === 2) {
        logger.info('Executing self-analysis', { 
          requestId, 
          userId,
          userData: {
            hasName: !!data.name,
            hasBirthdate: !!data.birthdate,
            hasGender: !!data.gender,
            hasMbti: !!data.mbti
          }
        });
        
        const analysisStartTime = Date.now();
        const analysisReport = await callGPT(SELF_ANALYSIS_MESSAGES(data), requestId);
        const analysisDuration = Date.now() - analysisStartTime;
        
        logger.info('Self-analysis completed', { 
          requestId, 
          userId,
          duration: analysisDuration,
          responseLength: analysisReport.length 
        });

        await replyText(replyToken, analysisReport);

        // DB保存
        const { error: analysisLogError } = await supabase.from('diagnosis_logs').insert([{
          line_user_id: userId,
          name: data.name,
          birthdate: data.birthdate,
          birthtime: data.birthtime || null,
          gender: data.gender,
          mbti: data.mbti || null,
          result: analysisReport,
          extra_credits: 1,
          session_closed: false,
          question: null,
        }]);

        if (analysisLogError) {
          logger.error('Analysis log insert error', { requestId, error: analysisLogError });
          await notifyError(analysisLogError, { requestId, userId, operation: 'analysisLogInsert' });
        }
      } else if (extraCredits === 2 && !hasAllInput) {
        logger.info('Sending template message', { requestId, userId });
        await replyText(replyToken, TEMPLATE_MSG);
      } else {
        logger.info('No action taken', { 
          requestId, 
          userId, 
          extraCredits, 
          hasAllInput,
          messagePreview: text.substring(0, 50)
        });
      }
    }

    const totalDuration = Date.now() - startTime;
    logger.info('Webhook request completed', { requestId, duration: totalDuration });
    
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    logger.error('Webhook processing error', { 
      requestId, 
      error: error.message, 
      stack: error.stack,
      duration: totalDuration 
    });
    
    await notifyError(error, { requestId, operation: 'webhookProcessing' });
    
    try {
      if (req.body && JSON.parse(req.body).events?.[0]?.replyToken) {
        const replyToken = JSON.parse(req.body).events[0].replyToken;
        await replyText(replyToken, 'システムエラーが発生しました。しばらく時間をおいて再度お試しください。');
      }
    } catch (replyError) {
      logger.error('Failed to send error reply', { requestId, error: replyError.message });
    }
  }
  
  res.sendStatus(200);
});

// ⓬ ヘルパー関数
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

async function callGPT(input, requestId = 'unknown') {
  const payload = Array.isArray(input)
    ? { messages: input }
    : { messages: [{ role: 'user', content: input }] };

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info('GPT API call started', { 
        requestId, 
        attempt, 
        messageCount: payload.messages.length 
      });

      const { data } = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          temperature: 0.7,
          max_tokens: 1500,
          ...payload,
        },
        {
          headers: {
            Authorization: `Bearer ${GPT_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000, // 30秒タイムアウト
        },
      );

      logger.info('GPT API call successful', { 
        requestId, 
        attempt,
        tokensUsed: data.usage?.total_tokens || 'unknown',
        responseLength: data.choices[0].message.content.length
      });

      return data.choices[0].message.content.trim();
      
    } catch (e) {
      logger.error('GPT API call failed', { 
        requestId, 
        attempt, 
        error: e.message,
        isLastAttempt: attempt === maxRetries
      });

      if (attempt === maxRetries) {
        await notifyError(e, { requestId, operation: 'gptApiCall', finalAttempt: true });
        return '診断中にエラーが発生しました。時間を置いて再試行してください。';
      }
      
      // 指数バックオフ
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
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
        timeout: 10000, // 10秒タイムアウト
      },
    );
    
    logger.info('LINE reply sent successfully', { 
      replyToken: token.substring(0, 10) + '***',
      messageLength: text.length 
    });
    
  } catch (error) {
    logger.error('LINE reply failed', { 
      replyToken: token.substring(0, 10) + '***',
      error: error.message 
    });
    throw error;
  }
}

// ⓭ 起動
app.listen(PORT, () => {
  logger.info('Server started successfully', { 
    port: PORT, 
    nodeEnv: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// プロセス終了時のクリーンアップ
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.exit(0);
});
