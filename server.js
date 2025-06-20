const crypto = require('crypto');

// StripeのWebhookイベントを受け取るエンドポイント
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // 後で設定するキー

  let event;

  try {
    event = require('stripe')(process.env.STRIPE_SECRET_KEY).webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const customerId = event.data.object.customer;

    // Supabaseに extra_credits = 5 を加算する処理
    updateUserCredits(customerId);
  }

  res.json({ received: true });
});

// ユーザーにクレジットを加算する処理
async function updateUserCredits(customerId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .update({ extra_credits: 5 })
      .eq('stripe_customer_id', customerId);

    if (error) {
      console.error('Supabase update error:', error);
    } else {
      console.log(`Added 5 credits to user ${customerId}`);
    }
  } catch (e) {
    console.error('Error updating credits:', e.message);
  }
}
