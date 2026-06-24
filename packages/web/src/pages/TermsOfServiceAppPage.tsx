import { Link } from 'react-router-dom';

/**
 * Terms of Service — iOS app variant. Public route at /legal/terms.
 */
export default function TermsOfServiceAppPage() {
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
          <h1 className="text-4xl lg:text-5xl font-extrabold mt-3 mb-2">Terms of Service — MyGasLink</h1>
          <p className="text-slate-500 dark:text-slate-400 mb-10">Effective date: 21 June 2026</p>

          <div className="space-y-8 text-slate-600 dark:text-slate-300 leading-relaxed">
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">1. PARTIES</h2>
              <p>
                These terms are between you (the Distributor or authorised user) and MyGasLink,
                operated by Suneel Marriboina.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">2. THE SERVICE</h2>
              <p>
                MyGasLink is a SaaS platform for LPG distribution management covering order management,
                GST e-invoicing, inventory tracking, delivery coordination, and customer management.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">3. YOUR ACCOUNT</h2>
              <p>
                You are responsible for all activity under your account and for keeping login
                credentials confidential. Notify us immediately at info@mygaslink.com if you suspect
                any unauthorised access to your account.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">4. YOUR DATA</h2>
              <p>
                You own all data you enter into MyGasLink. We process it solely to deliver the
                service. On account termination, your data remains available for export for 30 days.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">5. GST COMPLIANCE</h2>
              <p>
                MyGasLink facilitates GST e-invoice and e-Way Bill generation via the NIC portal.
                You remain solely responsible for the accuracy of all GST data entered through the
                platform. MyGasLink is not a GST advisor or tax consultant.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">6. SUBSCRIPTION AND PAYMENT</h2>
              <p>
                Subscription fees are as agreed at sign-up or renewal. Accounts with overdue fees
                may be suspended after 7 days written notice to the registered email address.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">7. LIMITATION OF LIABILITY</h2>
              <p>
                To the maximum extent permitted by law, MyGasLink&apos;s total liability for any claim
                is limited to the subscription fees paid by you in the 3 weeks immediately preceding
                the claim. We are not liable for any indirect, consequential, or loss-of-profit damages.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">8. TERMINATION</h2>
              <p>
                Either party may terminate with 30 days written notice. MyGasLink may suspend or
                terminate immediately for material breach, non-payment, or misuse of the platform.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">9. GOVERNING LAW</h2>
              <p>
                These terms are governed by the laws of India. Any dispute shall be subject to the
                exclusive jurisdiction of courts in Hyderabad, Telangana.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">10. CONTACT</h2>
              <p>MyGasLink, operated by Suneel Marriboina</p>
              <p>info@mygaslink.com</p>
              <p>Hyderabad, Telangana, India</p>
            </section>
          </div>

          <div className="mt-14 pt-8 border-t border-slate-200 dark:border-slate-800">
            <Link to="/legal/privacy" className="text-sm font-semibold text-flame-500 hover:underline">
              View Privacy Policy →
            </Link>
          </div>
        </article>
      </main>
    </div>
  );
}
