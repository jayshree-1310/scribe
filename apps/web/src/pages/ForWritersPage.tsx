import { PublicShell } from "../components/layout/PublicShell";
import { ButtonLink } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Icon, type IconName } from "../components/ui/Icon";
import "./landing.css";
import "./pages.css";

const STEPS: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: "pen",
    title: "Write a chapter at a time",
    body: "No need for a finished manuscript. Publish chapter one, see who turns up, keep going.",
  },
  {
    icon: "users",
    title: "Build an audience that waits for you",
    body: "Readers follow serials. A broadcast channel keeps them close between updates.",
  },
  {
    icon: "trend",
    title: "See what actually landed",
    body: "Views, read-through and ratings per chapter — so you know where readers stopped.",
  },
  {
    icon: "trophy",
    title: "Finish things with challenges",
    body: "A prompt and a deadline beats waiting for inspiration. Most writers finish their first story in one.",
  },
];

export function ForWritersPage() {
  return (
    <PublicShell>
      <section className="hero">
        <div className="container hero__inner hero__inner--single">
          <div className="hero__copy">
            <p className="hero__eyebrow">
              <Icon name="pen" size="0.95em" />
              For writers
            </p>

            <h1 className="hero__title">
              Publish the way people actually read.
            </h1>

            <p className="hero__lede">
              Scribe is built for serials: one chapter at a time, in front of
              readers who came back for the next one. Free to publish, yours to
              keep.
            </p>

            <div className="hero__actions">
              <ButtonLink
                variant="primary"
                size="lg"
                to="/author/stories/new"
                startIcon={<Icon name="plus" />}
              >
                Start a story
              </ButtonLink>

              <ButtonLink variant="secondary" size="lg" to="/author">
                Open the author studio
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>

      <section className="container section">
        <div className="card-grid">
          {STEPS.map((step) => (
            <Card key={step.title}>
              <span className="writers__icon">
                <Icon name={step.icon} size="1.3rem" />
              </span>

              <h2 className="writers__title">{step.title}</h2>
              <p className="writers__body">{step.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="container section">
        <div className="cta">
          <div className="cta__copy">
            <h2>Everything on Scribe is free to publish.</h2>
            <p>
              No exclusivity, no rights grab, no paywall between you and your
              readers. Delete it whenever you want.
            </p>
          </div>

          <div className="cta__actions">
            <ButtonLink variant="primary" size="lg" to="/register">
              Create your account
            </ButtonLink>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}
