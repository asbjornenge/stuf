ALTER TABLE spaces ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active';
