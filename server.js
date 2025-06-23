/*
 * server.js — LINE × Supabase × GPT  (セキュリティ・監視強化版 + ユーザー管理改善)
 * ----------------------------------------------------------------------
 * 追加機能
 * ✔ LINE署名検証でなりすまし防止
 * ✔ 構造化ログによる詳細な動作記録
 * ✔ エラー監視とアラート機能
 * ✔ レート制限による不正利用防止
 * ✔ セキュリティヘッダーとヘルスチェック
 * ✔ ユーザーごとの状態管理（重複レコード防止）
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

const FOLLOWUP_MSG = `🕊️ ここまでお付き合いいただき、本当にありがとうございました 🕊️

もしこのメッセージが
あなたの心に、ほんの少しでも灯をともすものであったなら
とても嬉しいです。

心に残ったフレーズや、気づいたことがあれば
ぜひ聞かせてくださいね。

───────────────

もっと深く自分を知りたくなったとき
誰かに話を聞いてほしくなったときは
いつでもお待ちしています。

💫 ココナラでは初回500円〜ご相談いただけます
▶︎ https://coconala.com/invite/CR0VNB
（新規登録で1,000円分のポイントプレゼント中）

🌙 公式LINEでは
・無料タロット診断
・ココナラ限定クーポン
・心が軽くなるメッセージ

などを不定期でお届けしています。
ぜひこのまま、ゆるやかにつながっていてくださいね。

あなたの毎日に、優しい光が降り注ぎますように ✨`;

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

# 出力構成
以下の要素を含めて構成してください（ただし番号や「導入の詩的なメッセージ」などの見出しは出力しないこと）：
- 自然な導入文（心を映す鏡としての語り）
- 🔹 本質を映すことば（性格・価値観）
- 🔹 宿る星と運命の流れ（占術ベースの現在の流れ）
- 🔹 天賦の才能（生まれ持った強み）
- 🔹 今、少し疲れているかもしれないこと（課題や傾向）
- 自然な締めの文章の後に以下の誘導文を必ず含める：

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
- 見出しの番号や説明文（「導入の詩的なメッセージ」など）は出力しないでください。
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

▼ 出力構成（以下の見出しは必ず使用すること）：

まず、カードと向き合う静かな導入文を書いてください（情景描写など）。

【今回引かれたカード】
🔹過去：カード名（日本語 / 英語）- 正位置/逆位置
　鑑定文（そのカードが示す過去の物語）

🔹現在：カード名（日本語 / 英語）- 正位置/逆位置
　鑑定文（そのカードが示す現在の状態）

🔹未来：カード名（日本語 / 英語）- 正位置/逆位置
　鑑定文（そのカードが示す未来への示唆）

【3枚のカードが紡ぐ物語】

過去のカードが示していたのは...（過去の状況と学び）

そして現在のカードは...（今の状態と向き合うべきこと）

未来のカードが導くのは...（これからの可能性と希望）

この3枚のカードを通して伝えたいメッセージ...（全体を通しての深い洞察と、相談内容「${concern}」への具体的なエール）

# 重要
- あなた自身で22枚の大アルカナからランダムに3枚を（過去・現在・未来の順）引き、正位置か逆位置もランダムに決定してください。
- カードを引いたあと、必ず上記の構成で出力してください。
- 個別のカード解説と、3枚の総合的な物語の両方を一度に出力してください。
- 「静かな導入文」などの説明は書かず、自然な文章として出力してください。`
  },
  {
    role: 'user',
    content: `相談内容：${concern}`,
  },
];

// 削除：TAROT_SUMMARY_MESSAGESは不要になったため

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

      // 📋 ユーザー状態取得 or 作成
      const userState = await getOrCreateUserState(userId, requestId);
      
      if (!userState) {
        await replyText(replyToken, 'システムエラーが発生しました。しばらく時間をおいて再度お試しください。');
        continue;
      }

      const { extra_credits: extraCredits, session_closed: sessionClosed } = userState;

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

      // 🔮 「特別プレゼント」の場合はLINE側で応答するので何もしない
      if (text === '特別プレゼント' && extraCredits === 1) {
        logger.info('Special present keyword detected - handled by LINE auto-response', { requestId, userId });
        
        // extra_creditsだけ更新（タロット待機状態へ）
        const { error: updateError } = await supabase
          .from('diagnosis_logs')
          .update({
            extra_credits: 0.5, // タロット待機状態を示す中間値
            updated_at: new Date().toISOString()
          })
          .eq('line_user_id', userId);

        if (updateError) {
          logger.error('Credit update error', { requestId, error: updateError });
          await notifyError(updateError, { requestId, userId, operation: 'creditUpdate' });
        }
        continue;
      }

      // 🎴 タロット相談内容受付（extra_credits: 0.5の時）
      if (extraCredits === 0.5) {
        logger.info('Executing tarot reading with concern', { requestId, userId });
        
        const tarotStartTime = Date.now();
        const tarotAns = await callGPT(TAROT_MESSAGES(text), requestId);
        const tarotDuration = Date.now() - tarotStartTime;
        
        logger.info('Tarot reading completed', { 
          requestId, 
          userId,
          duration: tarotDuration,
          responseLength: tarotAns.length,
          concern: text.substring(0, 30)
        });

        // タロット結果を送信（カード解説とストーリーを含む）
        await replyWithQuickReply(
          replyToken, 
          tarotAns,
          [{
            type: 'action',
            action: {
              type: 'message',
              label: '💝 特別なご案内を見る',
              text: '特別なご案内'
            }
          }]
        );
        
        // タロット結果を保存
        const { error: updateError } = await supabase
          .from('diagnosis_logs')
          .update({
            tarot_concern: text,
            tarot_result: tarotAns,
            extra_credits: 0.3, // 特別案内待機状態
            updated_at: new Date().toISOString()
          })
          .eq('line_user_id', userId);

        if (updateError) {
          logger.error('Tarot update error', { requestId, error: updateError });
          await notifyError(updateError, { requestId, userId, operation: 'tarotUpdate' });
        }
        continue;
      }

      // 💝 特別なご案内表示（extra_credits: 0.3の時）
      if (text === '特別なご案内' && extraCredits === 0.3) {
        logger.info('Showing special announcement', { requestId, userId });
        
        // フォローアップメッセージを送信
        await replyText(replyToken, FOLLOWUP_MSG);
        
        // 最終更新（extra_credits: 0, session_closed: true）
        const { error: updateError } = await supabase
          .from('diagnosis_logs')
          .update({
            extra_credits: 0,
            session_closed: true,
            updated_at: new Date().toISOString()
          })
          .eq('line_user_id', userId);

        if (updateError) {
          logger.error('Final update error', { requestId, error: updateError });
          await notifyError(updateError, { requestId, userId, operation: 'finalUpdate' });
        }
        continue;
      }

      // 🧠 自己分析フロー
      const data = extractUserData(text);
      const hasAllInput = data.name && data.birthdate && data.gender;

      // 「診断開始」の場合はLINE側で応答するので何もしない
      if (text === '診断開始' && extraCredits === 2) {
        logger.info('Diagnosis start keyword detected - handled by LINE auto-response', { requestId, userId });
        continue;
      }

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

        await replyWithQuickReply(
          replyToken, 
          analysisReport,
          [{
            type: 'action',
            action: {
              type: 'message',
              label: '🎁 特別プレゼントを受け取る',
              text: '特別プレゼント'
            }
          }]
        );

        // 自己分析結果で更新（extra_credits: 1）
        const { error: updateError } = await supabase
          .from('diagnosis_logs')
          .update({
            name: data.name,
            birthdate: data.birthdate,
            birthtime: data.birthtime || null,
            gender: data.gender,
            mbti: data.mbti || null,
            self_analysis_result: analysisReport,
            extra_credits: 1,
            session_closed: false,
            updated_at: new Date().toISOString()
          })
          .eq('line_user_id', userId);

        if (updateError) {
          logger.error('Analysis update error', { requestId, error: updateError });
          await notifyError(updateError, { requestId, userId, operation: 'analysisUpdate' });
        }
      } else if (extraCredits === 2 && !hasAllInput && text !== '診断開始') {
        // 「診断開始」以外のメッセージで、まだ情報が揃っていない場合
        logger.info('Incomplete user data - ignoring message', { requestId, userId });
        // 何も返信しない（LINEの自動応答に任せる）
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

// 🆕 ユーザー状態取得/作成関数
async function getOrCreateUserState(userId, requestId) {
  try {
    // まず既存のユーザーレコードを確認
    const { data: existingUser, error: selectError } = await supabase
      .from('diagnosis_logs')
      .select('*')
      .eq('line_user_id', userId)
      .single();

    if (selectError && selectError.code !== 'PGRST116') { // PGRST116 = No rows found
      logger.error('Database query error', { requestId, error: selectError, userId });
      await notifyError(selectError, { requestId, userId, operation: 'getUserState' });
      return null;
    }

    // ユーザーが存在する場合はそのまま返す
    if (existingUser) {
      logger.info('Existing user found', { 
        requestId, 
        userId: userId.substring(0, 8) + '***',
        extraCredits: existingUser.extra_credits,
        sessionClosed: existingUser.session_closed
      });
      return existingUser;
    }

    // 新規ユーザーの場合は作成
    logger.info('Creating new user record', { requestId, userId: userId.substring(0, 8) + '***' });
    
    const { data: newUser, error: insertError } = await supabase
      .from('diagnosis_logs')
      .insert([{
        line_user_id: userId,
        extra_credits: 2,
        session_closed: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (insertError) {
      logger.error('Failed to create new user', { requestId, error: insertError, userId });
      await notifyError(insertError, { requestId, userId, operation: 'createNewUser' });
      return null;
    }

    logger.info('New user created successfully', { 
      requestId, 
      userId: userId.substring(0, 8) + '***',
      extraCredits: newUser.extra_credits
    });
    
    return newUser;
    
  } catch (error) {
    logger.error('Unexpected error in getOrCreateUserState', { requestId, error: error.message, userId });
    await notifyError(error, { requestId, userId, operation: 'getOrCreateUserState' });
    return null;
  }
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

// 🆕 クイックリプライ付き返信
async function replyWithQuickReply(token, text, quickReplyItems) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      {
        replyToken: token,
        messages: [{
          type: 'text',
          text: text,
          quickReply: {
            items: quickReplyItems
          }
        }]
      },
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000
      }
    );
    
    logger.info('LINE reply with quick reply sent successfully', { 
      replyToken: token.substring(0, 10) + '***',
      quickReplyCount: quickReplyItems.length 
    });
    
  } catch (error) {
    logger.error('LINE reply with quick reply failed', { 
      replyToken: token.substring(0, 10) + '***',
      error: error.message 
    });
    throw error;
  }
}

// 🆕 プッシュメッセージ送信
async function pushMessage(userId, text) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      {
        to: userId,
        messages: [{ type: 'text', text }]
      },
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000
      }
    );
    
    logger.info('LINE push message sent successfully', { 
      userId: userId.substring(0, 10) + '***',
      messageLength: text.length 
    });
    
  } catch (error) {
    logger.error('LINE push message failed', { 
      userId: userId.substring(0, 10) + '***',
      error: error.message 
    });
    throw error;
  }
}

// 削除：extractTarotCardsも不要になったため

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
