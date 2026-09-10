import { Link } from "react-router-dom";
import { useAsync } from "../hooks/useAsync";
import { useAuth } from "../lib/auth";
import { formatCount } from "../lib/format";
import * as stories from "../data/stories-api";
import { PublicShell } from "../components/layout/PublicShell";
import { ButtonLink } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { StoryCover } from "../components/story/StoryCover";
import "./landing.css";

export function LandingPage() {
  const { session } = useAuth();

  const trending = useAsync(
    () =>
      stories
        .listStories({ sort: "trending", limit: 10 })
        .then((page) => page.items),
    [],
  );
  const heroStories = trending.data?.slice(0, 4) ?? [];

  return (
    <PublicShell>
      {/* Hero ------------------------------------------------------------ */}
      <section className="hero">
        <div className="container hero__inner">
          <div className="hero__copy">
            <p className="hero__eyebrow">
              <Icon name="sparkle" size="0.95em" />
              Over 90,000 stories, written by readers like you
            </p>

            <h1 className="hero__title">
              Every story is waiting for the reader who needed it.
            </h1>

            <p className="hero__lede">
              Scribe is where stories are read chapter by chapter and written in
              public. Follow the serials you love, join the clubs arguing about
              them, and publish your own when you're ready.
            </p>

            <div className="hero__actions">
              <ButtonLink
                variant="primary"
                size="lg"
                to={session ? "/home" : "/register"}
                startIcon={<Icon name="book-open" />}
              >
                Start Reading
              </ButtonLink>
              <ButtonLink
                variant="secondary"
                size="lg"
                to="/for-writers"
                startIcon={<Icon name="pen" />}
              >
                Start Writing
              </ButtonLink>
            </div>

            <dl className="hero__stats">
              <div>
                <dt>Stories</dt>
                <dd>91,400</dd>
              </div>
              <div>
                <dt>Chapters read daily</dt>
                <dd>1.2M</dd>
              </div>
              <div>
                <dt>Active book clubs</dt>
                <dd>8,600</dd>
              </div>
            </dl>
          </div>

          {/* Editorial visual: real covers, fanned like books on a table. */}
          <div className="hero__visual" aria-hidden="true">
            {heroStories.length > 0 ? (
              <div className="hero__fan">
                {heroStories.map((story, index) => (
                  <div
                    className="hero__fan-item"
                    key={story.id}
                    data-index={index}
                  >
                    <StoryCover story={story} size="lg" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="hero__fan hero__fan--placeholder" />
            )}
          </div>
        </div>
      </section>

      {/* Continue reading is absent until reading progress is recorded --
          there is no endpoint for a resume point yet, and the shelf used to be
          filled from invented history. */}

      {/* Closing CTA ----------------------------------------------------- */}
      <section className="container section">
        <div className="cta">
          <div className="cta__copy">
            <h2>Your first chapter is the hardest. Then it's just Tuesdays.</h2>
            <p>
              Publish a chapter at a time, build a channel your readers actually
              subscribe to, and see exactly which chapter they couldn't put
              down.
            </p>
          </div>
          <div className="cta__actions">
            <ButtonLink variant="primary" size="lg" to="/register">
              Create your account
            </ButtonLink>
            <Link className="cta__link" to="/for-writers">
              How publishing works
              <Icon name="arrow-right" size="0.9em" />
            </Link>
          </div>
        </div>
      </section>

      {/* Trust line ------------------------------------------------------ */}
      <p className="container landing__trust">
        {formatCount(2400000)} readers · free to read · free to publish
      </p>
    </PublicShell>
  );
}
