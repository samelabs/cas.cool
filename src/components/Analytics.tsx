import Script from 'next/script'
import { getSiteConfig } from '@/lib/site'

/**
 * 51.la analytics — official standard embed.
 * Configured dynamically via SiteConfig.analyticsId. If unset, nothing is injected.
 */
export default async function Analytics() {
  const site = await getSiteConfig()
  if (!site.analyticsId) return null

  const analyticsId = site.analyticsId
  return (
    <Script id="la-analytics" strategy="afterInteractive">
      {`
        (function(){
          var s = document.createElement('script');
          s.src = '//sdk.51.la/js-sdk-pro.min.js';
          s.async = true;
          s.onload = function() {
            if (window.LA) {
              window.LA.init({ id: ${JSON.stringify(analyticsId)}, ck: ${JSON.stringify(analyticsId)} });
            }
          };
          document.head.appendChild(s);
        })();
      `}
    </Script>
  )
}
