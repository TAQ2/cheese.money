import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
}));

const { ThreadErrorBanner } = await import("./ThreadErrorBanner");

const RAW_ERROR = "Failed to authenticate: OAuth session expired and could not be refreshed.";

describe("ThreadErrorBanner", () => {
  it("renders nothing without an error", () => {
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={null} />);
    expect(markup).toBe("");
  });

  it("swaps in a headline, a Sign in link, and collapses the raw text for auth_error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={RAW_ERROR} errorClass="auth_error" />,
    );

    expect(markup).toContain("Authentication error");
    expect(markup).toContain("Sign in");
    expect(markup).toContain("Show details");
    // Collapsed by default: the raw CLI text is not in the initial markup at all.
    expect(markup).not.toContain(RAW_ERROR);
  });

  it("keeps today's plain rendering for a provider_error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={RAW_ERROR} errorClass="provider_error" />,
    );

    expect(markup).toContain(RAW_ERROR);
    expect(markup).not.toContain("Authentication error");
    expect(markup).not.toContain("Sign in");
    expect(markup).not.toContain("Show details");
  });

  it("keeps today's plain rendering when no class is present (backward compatibility)", () => {
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={RAW_ERROR} />);

    expect(markup).toContain(RAW_ERROR);
    expect(markup).not.toContain("Authentication error");
    expect(markup).not.toContain("Sign in");
  });

  it("keeps today's plain rendering when the class is explicitly null", () => {
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={RAW_ERROR} errorClass={null} />);

    expect(markup).toContain(RAW_ERROR);
    expect(markup).not.toContain("Authentication error");
  });

  it("keeps the Dismiss button for every rendering path", () => {
    const plain = renderToStaticMarkup(
      <ThreadErrorBanner error={RAW_ERROR} onDismiss={() => {}} />,
    );
    expect(plain).toContain("Dismiss error");

    const auth = renderToStaticMarkup(
      <ThreadErrorBanner error={RAW_ERROR} errorClass="auth_error" onDismiss={() => {}} />,
    );
    expect(auth).toContain("Dismiss error");
  });

  it("omits the Dismiss button when no handler is given", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={RAW_ERROR} errorClass="auth_error" />,
    );
    expect(markup).not.toContain("Dismiss error");
  });
});
