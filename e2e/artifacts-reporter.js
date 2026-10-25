// e2e/artifacts-reporter.js
//
// Copies every test's video and screenshots out of test-results/ (named by
// Playwright's hashes, and wiped at the start of each run) into artifacts/,
// named by spec and test so a run can be watched back page by page:
//
//   artifacts/videos/04-fire-alert/01-turning-fire-alerts-on-raises-....webm
//   artifacts/screenshots/04-fire-alert/01-turning-fire-alerts-on-raises-....png
//
// A run replaces the files of the tests it ran and leaves the others, so
// running one spec does not throw away the rest. Attachments other than the
// default video / screenshot (spec 04's Firefox playback, for one) keep their
// attachment name as a suffix.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ARTIFACTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts");

const KINDS = [
  {
    dir: "videos",
    match: (type) => type.startsWith("video/"),
    fallback: "video",
    extension: (a) => (a.path ? path.extname(a.path) : ".webm"),
  },
  {
    dir: "screenshots",
    match: (type) => type === "image/png",
    fallback: "screenshot",
    extension: () => ".png",
  },
];

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export default class ArtifactsReporter {
  onTestEnd(test, result) {
    const spec = path.basename(test.location.file).replace(/\.spec\.js$|\.js$/, "");
    // Order within the file, so the folder lists in the order the story runs.
    const index = test.parent.allTests().indexOf(test) + 1;
    const base = `${String(index).padStart(2, "0")}-${slug(test.title)}`;

    for (const kind of KINDS) {
      // From a file (videos, automatic screenshots) or in memory (testInfo.attach({ body })).
      const attachments = result.attachments.filter(
        (a) => (a.path || a.body) && kind.match(a.contentType)
      );
      attachments.forEach((attachment) => {
        if (attachment.path && !fs.existsSync(attachment.path)) return;
        const extra = attachment.name === kind.fallback ? "" : `-${slug(attachment.name)}`;
        // Several under one name (a screenshot per page, say): number them.
        const same = attachments.filter((a) => a.name === attachment.name);
        const count = same.length > 1 ? `-${same.indexOf(attachment) + 1}` : "";
        const target = path.join(
          ARTIFACTS_DIR,
          kind.dir,
          spec,
          `${base}${extra}${count}${kind.extension(attachment)}`
        );
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (attachment.path) fs.copyFileSync(attachment.path, target);
        else fs.writeFileSync(target, attachment.body);
      });
    }
  }

  onEnd() {
    if (fs.existsSync(ARTIFACTS_DIR)) {
      console.log(`[artifacts] videos and screenshots in ${path.relative(process.cwd(), ARTIFACTS_DIR) || "."}/`);
    }
  }
}
