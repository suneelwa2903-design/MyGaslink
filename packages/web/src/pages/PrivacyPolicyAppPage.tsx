import { Link } from 'react-router-dom';

/**
 * Privacy Policy — iOS app variant. Public route at /legal/privacy.
 *
 * This keeps the existing /privacy page intact for the web + Android
 * surfaces while giving the iOS app an Apple-review-safe legal page that
 * matches the individual developer account identity.
 */
export default function PrivacyPolicyAppPage() {
  return (
    <div className="min-h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="border-b border-slate-200 dark:border-slate-800 px-6 lg:px-12 xl:px-20 py-5">
        <div className="max-w-3xl mx-auto flex items-center">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="MyGasLink" className="h-8 w-8 rounded-lg object-contain" />
            <span className="text-base font-extrabold">
              MyGas<span className="text-flame-500">Link</span>
            </span>
          </div>
        </div>
      </header>

      <main className="px-6 lg:px-12 xl:px-20 py-16">
        <article className="max-w-3xl mx-auto">
          <span className="text-xs font-bold text-flame-500 uppercase tracking-widest">Legal</span>
          <h1 className="text-4xl lg:text-5xl font-extrabold mt-3 mb-2">Privacy Policy — MyGasLink</h1>
          <p className="text-slate-500 dark:text-slate-400 mb-10">Effective date: 21 June 2026</p>

          <div className="space-y-8 text-slate-600 dark:text-slate-300 leading-relaxed">
            <p>
              MyGasLink, operated by Suneel Marriboina (&quot;MyGasLink&quot;,
              &quot;we&quot;, &quot;us&quot;), provides the MyGasLink mobile application and related services.
            </p>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">1. DATA FIDUCIARY IDENTITY</h2>
              <p>MyGasLink, operated by Suneel Marriboina</p>
              <p>Hyderabad, Telangana, India</p>
              <p>Email: info@mygaslink.com</p>
              <p className="mt-4">Grievance Officer: Suneel Marriboina</p>
              <p>Contact: info@mygaslink.com</p>
              <p>We will acknowledge your complaint within 48 hours and resolve it within 30 days.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">2. WHAT DATA WE COLLECT</h2>
              <p>Account data: name, email, phone number, business name, GSTIN.</p>
              <p className="mt-3">
                Driver data: name, phone, driving licence number, real-time GPS location
                (foreground only, during active delivery trips, at 60-second intervals).
              </p>
              <p className="mt-3">
                Financial data: invoice amounts, payment records, GST reference numbers
                (IRN and e-Way Bill numbers).
              </p>
              <p className="mt-3">Usage data: anonymised crash reports. No personal data is included in crash reports.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">3. WHY WE COLLECT IT</h2>
              <p>
                Account and financial data: to deliver the service and meet statutory obligations
                under the GST Act, 2017 and Income Tax Act, 1961.
              </p>
              <p className="mt-3">Driver GPS: delivery tracking and trip management.</p>
              <p className="mt-3">Crash data: platform reliability and error diagnosis.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">4. WHO WE SHARE YOUR DATA WITH</h2>
              <p>We do not sell your data. We share data only with:</p>
              <p className="mt-3">
                NIC / WhiteBooks Technologies: for GST e-invoice and e-Way Bill generation
                mandatory under GST law.
              </p>
              <p className="mt-3">Amazon Web Services (Mumbai, ap-south-1): all data is hosted in India.</p>
              <p className="mt-3">Sentry: anonymised crash reports only. No personal data is shared.</p>
              <p className="mt-3">We use no advertising networks, analytics SDKs, or tracking tools of any kind.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">5. HOW LONG WE KEEP YOUR DATA</h2>
              <p>GST and invoice records: 8 years (GST Act, 2017 statutory minimum).</p>
              <p className="mt-3">Payment records: 8 years (Income Tax Act, 1961 statutory minimum).</p>
              <p className="mt-3">Driver GPS location: deleted within 30 days of trip completion.</p>
              <p className="mt-3">Deleted accounts: anonymised after 90 days.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">6. YOUR RIGHTS (DPDP Act, 2023)</h2>
              <p>
                You have the right to access the personal data we hold about you, to correct
                inaccurate data, to request erasure (subject to statutory retention obligations),
                and to raise a grievance.
              </p>
              <p className="mt-3">To exercise any right, email: info@mygaslink.com</p>
              <p>We will respond within 30 days.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">7. ACCOUNT DELETION</h2>
              <p>
                You can request account deletion directly in the app: go to Profile / Settings
                and choose &quot;Delete Account&quot;. The request takes effect after a 30-day grace
                period during which you may cancel. Alternatively, email info@mygaslink.com with
                the subject line &quot;Account Deletion Request&quot; from your registered email address.
                Financial and GST records will be retained for the statutory period as required by law.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">8. SECURITY</h2>
              <p>
                All data in transit is encrypted via HTTPS/TLS. All data at rest is encrypted
                using AES-256 (AWS KMS). Passwords are hashed using bcrypt and are never stored in
                plain text. Access is controlled via JWT-based authentication with short-lived tokens.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">9. CHILDREN</h2>
              <p>MyGasLink is a business platform intended for adults. We do not knowingly collect data from individuals under 18 years of age.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">10. CHANGES TO THIS POLICY</h2>
              <p>We will notify registered users via in-app notification at least 30 days before any material change takes effect.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">11. CONTACT</h2>
              <p>MyGasLink, operated by Suneel Marriboina</p>
              <p>info@mygaslink.com</p>
              <p>Hyderabad, Telangana, India</p>
            </section>
          </div>

          <div className="mt-14 pt-8 border-t border-slate-200 dark:border-slate-800">
            <Link to="/legal/terms" className="text-sm font-semibold text-flame-500 hover:underline">
              View Terms of Service →
            </Link>
          </div>
        </article>
      </main>
    </div>
  );
}
