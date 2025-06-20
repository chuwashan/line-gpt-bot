const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post('/webhook', async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userMessage = event.message.text;
      const replyToken = event.replyToken;

      try {
        const gptRes = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: userMessage }]
          },
          {
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const replyText = gptRes.data.choices[0].message.content;

        await axios.post(
          'https://api.line.me/v2/bot/message/reply',
          {
            replyToken,
            messages: [{ type: 'text', text: replyText }]
          },
          {
            headers: {
              Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
      } catch (err) {
        console.error('Error:', err.response?.data || err.message);
      }
    }
  }

  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('LINE GPT Bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
