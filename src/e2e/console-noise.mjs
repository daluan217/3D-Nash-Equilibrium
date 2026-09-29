// Third-party analytics failing to load is not an app defect. It is identified by the failing resource's URL:
// WebKit's offline text names no host ("The Internet connection appears to be offline.", sweep 12 §75/§83), and
// Chromium's names only the error ("net::ERR_INTERNET_DISCONNECTED"). An own-origin failure is never matched.
const ANALYTICS_URL = /^https?:\/\/(([a-z0-9-]+\.)*(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net)|(www\.)?google\.com\/g\/collect)[/?]/i;
export const isAnalyticsNoise = ({ text = '', url = '' }) =>
  ANALYTICS_URL.test(url) || /googletagmanager|google-analytics|gtag|doubleclick|region1\.analytics/i.test(text);
