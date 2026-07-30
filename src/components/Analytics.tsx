import Script from 'next/script'

/**
 * 51.la analytics — official standard embed.
 *
 * Uses a single inline script with the SDK load + LA.init call together,
 * guaranteeing execution order (no race between two independent Script tags).
 */
export default function Analytics() {
  return (
    <Script id="la-analytics" strategy="afterInteractive">
      {`
        (function(){
          var s = document.createElement('script');
          s.src = '//sdk.51.la/js-sdk-pro.min.js';
          s.async = true;
          s.onload = function() {
            if (window.LA) {
              window.LA.init({ id: '1vMIE9ufxjzLp8iD', ck: '1vMIE9ufxjzLp8iD' });
            }
          };
          document.head.appendChild(s);
        })();
      `}
    </Script>
  )
}
