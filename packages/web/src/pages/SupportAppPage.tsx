/**
 * Support page for App Store Connect metadata and reviewer reference.
 * Public route at /legal/support.
 */
export default function SupportAppPage() {
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
          <span className="text-xs font-bold text-flame-500 uppercase tracking-widest">Support</span>
          <h1 className="text-4xl lg:text-5xl font-extrabold mt-3 mb-6">MyGasLink App Support</h1>
          <div className="space-y-8 text-slate-600 dark:text-slate-300 leading-relaxed">
            <p>
              MyGasLink is operated by Suneel Marriboina. For help with the
              iOS application, account access, or reviewer questions, contact us using the details below.
            </p>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">Contact</h2>
              <p>Email: info@mygaslink.com</p>
              <p>Location: Hyderabad, Telangana, India</p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">In-App Support Paths</h2>
              <p>Distributor admin / finance / inventory: Profile or Settings screens.</p>
              <p>Driver and customer: Profile or Account screens.</p>
              <p>Account deletion: available directly inside the mobile app under Delete Account.</p>
            </section>

            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3">Legal</h2>
              <p>Privacy Policy: /legal/privacy</p>
              <p>Terms of Service: /legal/terms</p>
            </section>
          </div>
        </article>
      </main>
    </div>
  );
}
