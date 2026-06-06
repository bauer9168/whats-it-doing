WID v83 deploy steps

1. Upload this entire folder/zip to Netlify as the site deploy.
2. Keep these root files exactly named:
   - index.html
   - customer-thread.html
   - operator.html
   - netlify.toml
   - package.json
   - supabase_thread_schema.sql
3. Keep the function files under:
   - netlify/functions/
4. Do not upload/use customer-thread.html.jscheck.js. That was only a local syntax-check helper.
5. In Supabase, open SQL Editor and run supabase_thread_schema.sql once.
6. In Netlify environment variables, set:
   - STRIPE_SECRET_KEY
   - STRIPE_WEBHOOK_SECRET
   - SUPABASE_URL
   - SUPABASE_SERVICE_ROLE_KEY
   - OPERATOR_PIN recommended
   - RESEND_API_KEY and FROM_EMAIL optional for emailed thread links
7. In Stripe webhook settings, point checkout.session.completed to:
   https://YOUR-DOMAIN/.netlify/functions/stripe-webhook
8. Public customer page:
   https://YOUR-DOMAIN/
9. Customer thread page:
   https://YOUR-DOMAIN/thread?session_id=...
   or https://YOUR-DOMAIN/customer-thread.html?session_id=...
10. Operator page:
   https://YOUR-DOMAIN/operator
   or https://YOUR-DOMAIN/operator.html
