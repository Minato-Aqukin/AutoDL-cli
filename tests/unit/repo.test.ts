import { describe, expect, it } from "vitest";
import { UsageError } from "../../src/core/errors.js";
import {
  parseRepo,
  redactCredentials,
  resolveGitToken,
  withCredentials,
} from "../../src/core/repo.js";

describe("parseRepo", () => {
  it("parses an https URL", () => {
    const repo = parseRepo("https://github.com/openai/whisper");
    expect(repo).toMatchObject({
      host: "github.com",
      path: "openai/whisper",
      name: "whisper",
      cloneUrl: "https://github.com/openai/whisper.git",
      needsAcceleration: true,
    });
  });

  it("strips a trailing .git and trailing slashes", () => {
    expect(parseRepo("https://github.com/openai/whisper.git").path).toBe("openai/whisper");
    expect(parseRepo("https://github.com/openai/whisper/").path).toBe("openai/whisper");
  });

  it("parses scp-style git@ URLs", () => {
    const repo = parseRepo("git@github.com:openai/whisper.git");
    expect(repo).toMatchObject({ host: "github.com", path: "openai/whisper", name: "whisper" });
    // Always normalised to https, since we authenticate with a token, not a key.
    expect(repo.cloneUrl).toBe("https://github.com/openai/whisper.git");
  });

  it("treats a bare owner/repo as GitHub", () => {
    expect(parseRepo("openai/whisper")).toMatchObject({
      host: "github.com",
      path: "openai/whisper",
    });
  });

  it("handles nested GitLab group paths", () => {
    const repo = parseRepo("https://gitlab.com/group/subgroup/project");
    expect(repo.path).toBe("group/subgroup/project");
    expect(repo.name).toBe("project");
  });

  describe("academic acceleration applies only where AutoDL documents it", () => {
    it.each(["github.com", "huggingface.co"])("accelerates %s", (host) => {
      expect(parseRepo(`https://${host}/a/b`).needsAcceleration).toBe(true);
    });

    it.each(["gitee.com", "gitlab.com", "git.example.com"])("does not accelerate %s", (host) => {
      // The proxy covers only GitHub/HuggingFace; Gitee is domestic and doesn't need it.
      expect(parseRepo(`https://${host}/a/b`).needsAcceleration).toBe(false);
    });
  });

  it.each(["", "   ", "not a url", "https://github.com/onlyowner"])(
    "rejects %j with a usage error",
    (input) => {
      expect(() => parseRepo(input)).toThrow(UsageError);
    },
  );
});

describe("withCredentials", () => {
  const repo = parseRepo("https://github.com/owner/private-repo");

  it("returns the plain URL when there is no token", () => {
    const { url, display } = withCredentials(repo);
    expect(url).toBe("https://github.com/owner/private-repo.git");
    expect(display).toBe(url);
  });

  it("embeds the token for the real URL", () => {
    expect(withCredentials(repo, "ghp_secret123").url).toBe(
      "https://x-access-token:ghp_secret123@github.com/owner/private-repo.git",
    );
  });

  it("never puts the token in the display form", () => {
    // `display` is what reaches logs, errors and --json output.
    const { display } = withCredentials(repo, "ghp_secret123");
    expect(display).not.toContain("ghp_secret123");
    expect(display).toContain("***");
  });
});

describe("redactCredentials", () => {
  it("masks a credential embedded in a URL", () => {
    expect(redactCredentials("git clone https://x-access-token:ghp_abc@github.com/o/r.git")).toBe(
      "git clone https://***@github.com/o/r.git",
    );
  });

  it("masks every occurrence in a longer command", () => {
    const command =
      "git remote set-url origin https://x-access-token:tok@github.com/o/r.git && git clone https://user:pw@gitee.com/a/b.git";
    const redacted = redactCredentials(command);
    expect(redacted).not.toContain("tok@");
    expect(redacted).not.toContain("pw@");
  });

  it("leaves credential-free text untouched", () => {
    const clean = "git clone https://github.com/o/r.git";
    expect(redactCredentials(clean)).toBe(clean);
  });
});

describe("resolveGitToken", () => {
  it("prefers the explicit flag", () => {
    process.env.GITHUB_TOKEN = "from-env";
    try {
      expect(resolveGitToken("from-flag")).toBe("from-flag");
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("falls back to the usual environment variables", () => {
    process.env.GITHUB_TOKEN = "from-env";
    try {
      expect(resolveGitToken()).toBe("from-env");
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("treats blank values as absent", () => {
    expect(resolveGitToken("   ")).toBeUndefined();
    expect(resolveGitToken()).toBeUndefined();
  });
});
