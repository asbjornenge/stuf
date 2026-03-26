import { config } from 'tiny-env-config';

export const PORT = config('PORT', '3000');
export const BASE_PATH = config('BASE_PATH', '').replace(/\/+$/, '');
export const MODE = config('MODE', 'standalone');
export const DATABASE_URL = config('DATABASE_URL', 'postgresql://stuf:stuf@localhost:5432/stuf');
export const SENTRY_DSN = config('SENTRY_DSN', '');
export const VAPID_CONTACT = config('VAPID_CONTACT', 'mailto:stuf@localhost');
export const PAYMENTS_ENABLED = config('PAYMENTS_ENABLED', 'false') === 'true';
export const STRIPE_SECRET_KEY = config('STRIPE_SECRET_KEY', '');
export const STRIPE_PRICE_ID = config('STRIPE_PRICE_ID', '');
export const STRIPE_WEBHOOK_SECRET = config('STRIPE_WEBHOOK_SECRET', '');
export const BODY_LIMIT = config('BODY_LIMIT', '50mb');
