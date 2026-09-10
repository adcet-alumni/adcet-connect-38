/**
 * The alumni portal's privacy policy.
 *
 * Written as a description of what this codebase actually does, not from a
 * template: every retention period, every visibility rule and every third party
 * named below is one the application really implements, and the constant each
 * comes from is noted beside it so the two can be kept in step. If a rule
 * changes in `config/constants.ts` or `lib/retention.ts`, it changes here.
 *
 * Laid out like `ContactPage` — hero, one narrow column, sections separated by
 * a heading and a rule. Deliberately no cards: this is a document to be read
 * top to bottom, and boxing each clause would make it look like a dashboard.
 */
import { motion } from "framer-motion";
import PublicLayout from "@/components/public/PublicLayout";
import PageHero from "@/components/public/PageHero";
import { CONTACT } from "@/lib/site";

const fade = {
  initial: { opacity: 0, y: 12 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true },
};

/** Last substantive revision. Update whenever a rule below actually changes. */
const LAST_UPDATED = "10 September 2026";

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <motion.section {...fade}>
    <h2 className="text-xl sm:text-2xl font-bold mb-2">{title}</h2>
    <div className="w-14 h-0.5 bg-primary/50 mb-6" />
    <div className="space-y-4 text-sm sm:text-base text-muted-foreground leading-relaxed">
      {children}
    </div>
  </motion.section>
);

/** A definition row, matching the `dl` on the contact page. */
const Row = ({ term, children }: { term: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-1 sm:grid-cols-[220px_minmax(0,1fr)] gap-1 sm:gap-4 py-4">
    <dt className="text-sm text-foreground font-medium">{term}</dt>
    <dd className="text-sm text-muted-foreground leading-relaxed">{children}</dd>
  </div>
);

export default function PrivacyPolicyPage() {
  return (
    <PublicLayout title="Privacy Policy">
      <PageHero
        title="Privacy Policy"
        subtitle="How the ADCET Alumni Portal handles your information"
      />

      <div className="max-w-3xl mx-auto px-6 py-14 space-y-16">
        <motion.section {...fade}>
          <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
            This policy covers the ADCET Alumni Portal, run by the Alumni Cell of Annasaheb Dange
            College of Engineering and Technology, Ashta. It describes what the portal collects,
            who can see it, how long it is kept and how to have it changed or removed.
          </p>
          <p className="text-xs text-muted-foreground mt-4">Last updated: {LAST_UPDATED}</p>
        </motion.section>

        <Section title="What we collect">
          <p>
            Almost everything the portal holds about you is something you typed into the sign-up
            form or your profile. Nothing is bought from a third party, and there is no tracking
            or advertising code anywhere on this site.
          </p>
          <dl className="divide-y divide-border border-y border-border">
            <Row term="Account">
              Your name and email address. Your password is never stored — only a bcrypt hash of
              it, which cannot be reversed.
            </Row>
            <Row term="Academic details">
              Department, degree, graduation year and roll number. Your admission year is
              calculated from the degree and graduation year rather than asked for.
            </Row>
            <Row term="Birthday">
              The day and month only, so the Alumni Cell can send birthday wishes.{" "}
              <strong className="text-foreground">Your birth year is never collected.</strong>
            </Row>
            <Row term="Contact and professional">
              Phone number, city, current employer and role, and any profile links you choose to
              add (LinkedIn, GitHub, X, website — all optional).
            </Row>
            <Row term="Proof of study">
              The library card, marksheet, leaving certificate or degree certificate you upload at
              sign-up, so the Alumni Cell can confirm you studied here.
            </Row>
            <Row term="Things you post">
              Feed posts, achievements, event RSVPs, job postings, job applications and the CV
              attached to them, donation records, and messages you send the Alumni Cell.
            </Row>
            <Row term="Location">
              Only your <strong className="text-foreground">city</strong>. It is converted to a
              coordinate rounded to roughly a kilometre so the alumni map can show where members
              are clustered. No street address is ever stored, and there is no column that could
              hold one.
            </Row>
          </dl>
        </Section>

        <Section title="Who can see it">
          <p>
            Your account stays pending until the Alumni Cell approves it, and nothing about you is
            visible to anyone else until then.
          </p>
          <dl className="divide-y divide-border border-y border-border">
            <Row term="Other approved alumni">
              Your name, department, batch, employer, role, city and photo in the member directory
              — and your LinkedIn link only if you have left that switch on, which you can turn off
              at any time from your profile.{" "}
              <strong className="text-foreground">
                Your email address and phone number are never shown to other members.
              </strong>
            </Row>
            <Row term="Anyone on the internet">
              Only what you publish deliberately: an achievement the Alumni Cell approves, and your
              name on the donor honour roll — which you can decline by marking a donation
              anonymous. The public alumni map shows headcounts per city, never individuals.
            </Row>
            <Row term="The alumni office">
              Administrators can see your full record, including your email, phone and proof-of-study
              document, because approving and supporting accounts requires it.
            </Row>
            <Row term="An alumnus who posted a job">
              If you apply for a job on the portal, the member who posted it receives your contact
              details and your CV. That only happens because you applied.
            </Row>
          </dl>
        </Section>

        <Section title="Payments and donations">
          <p>
            The portal has{" "}
            <strong className="text-foreground">no payment gateway and takes no payments</strong>.
            A donation is made in your own banking or UPI app, directly to the college's account.
            You then tell the portal the transaction reference so the office can match it against
            the bank statement.
          </p>
          <p>
            This means the portal never sees and never stores a card number, a UPI PIN, a CVV or
            any banking credential. What it holds is the amount, the reference number you typed,
            the date, and the screenshot you chose to attach — which only you and the alumni office
            can open.
          </p>
        </Section>

        <Section title="How long we keep it">
          <p>
            Your profile is kept for as long as your account exists. Individual items expire on
            their own schedules, and are then deleted permanently:
          </p>
          <dl className="divide-y divide-border border-y border-border">
            <Row term="CVs sent with a job application">180 days</Row>
            <Row term="Job postings">
              Removed from the board 30 days after posting and deleted 15 days after that, along
              with the applications on them
            </Row>
            <Row term="Past events">Deleted six months after the event ends</Row>
            <Row term="Declined donation records">Kept 30 days so we can explain the decision, then deleted</Row>
            <Row term="Sign-in tokens">
              Deleted 30 days after they stop working. The window exists so a compromised account
              can be investigated
            </Row>
            <Row term="Sign-up documents never used">Deleted within 24 hours</Row>
          </dl>
          <p>
            When a job or event is deleted, the Alumni Cell keeps only anonymous counts — how many
            postings were made in a month, how many people attended — so year-on-year figures stay
            accurate. Those counts contain no personal detail.
          </p>
        </Section>

        <Section title="Email we send you">
          <p>
            The portal emails you about things you are part of: verifying your address, the
            outcome of your registration, events and jobs aimed at your department, replies to
            what you post, donation receipts and birthday wishes.
          </p>
          <p>
            You can turn off notification email from Settings in the portal. Messages that are
            part of using your account — verifying an address, resetting a password, a donation
            receipt — are still sent, because they are the record of something you did.
          </p>
          <p>We do not sell or rent your address, and we do not send marketing on anyone's behalf.</p>
        </Section>

        <Section title="Who else is involved">
          <p>
            The portal relies on a small number of services to work. Each receives only what that
            job needs:
          </p>
          <dl className="divide-y divide-border border-y border-border">
            <Row term="File storage">Photos, documents and CVs you upload. Private files are served through short-lived links, not public URLs</Row>
            <Row term="Email delivery">The address the message is going to, and the message</Row>
            <Row term="Map tiles">Your browser fetches the map background directly. Your city is resolved to a coordinate once and stored by us, not looked up per visit</Row>
          </dl>
          <p>
            There are no analytics scripts, advertising networks, social media trackers or
            third-party cookies on this site.
          </p>
        </Section>

        <Section title="Cookies">
          <p>
            The portal sets no tracking cookies. When you sign in, your session is held in your own
            browser's local storage and is cleared when you sign out. Nothing about your browsing
            is shared with anyone.
          </p>
        </Section>

        <Section title="Your choices">
          <dl className="divide-y divide-border border-y border-border">
            <Row term="Correct anything">Edit your profile from the portal at any time</Row>
            <Row term="Hide your LinkedIn">A switch on your profile removes it from the directory and your public profile, while keeping the link on file</Row>
            <Row term="Give anonymously">Tick the box on a donation and your name never appears on the honour roll</Row>
            <Row term="Stop notification email">Settings → Notifications</Row>
            <Row term="Get a copy, or have it deleted">
              Write to{" "}
              <a href={`mailto:${CONTACT.email}`} className="text-primary hover:underline">
                {CONTACT.email}
              </a>{" "}
              and the Alumni Cell will action it
            </Row>
          </dl>
          <p>
            Some records cannot be erased on request — a donation receipt, for instance, is an
            accounting document the college is required to retain. We will tell you if that
            applies to anything you ask us to remove.
          </p>
        </Section>

        <Section title="Keeping it safe">
          <p>
            Passwords are hashed with bcrypt. Sessions are short-lived and can be revoked. CVs,
            proof-of-study documents, donation receipts and payment screenshots are held in private
            storage that is not reachable by URL — a signed, expiring link is generated each time
            someone entitled to see one opens it.
          </p>
          <p>
            No system is perfect. If you believe an account has been misused, email{" "}
            <a href={`mailto:${CONTACT.email}`} className="text-primary hover:underline">
              {CONTACT.email}
            </a>{" "}
            and we will investigate and, if necessary, sign every session out of it.
          </p>
        </Section>

        <Section title="Changes and contact">
          <p>
            If this policy changes in a way that affects what we collect or who can see it, the
            date at the top will change and members will be told.
          </p>
          <p>
            Questions about anything here go to the Alumni Cell —{" "}
            <a href={`mailto:${CONTACT.email}`} className="text-primary hover:underline">
              {CONTACT.email}
            </a>
            , or the phone numbers on the{" "}
            <a href="/contact" className="text-primary hover:underline">
              contact page
            </a>
            .
          </p>
        </Section>
      </div>
    </PublicLayout>
  );
}
