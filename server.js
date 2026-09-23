// Multi-user Field Notes backend
// Accounts, sessions, text notes, and images are stored on the server.
// For production, use persistent storage/volume and HTTPS.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const USERS_DIR = path.join(DATA_DIR, "users");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(USERS_DIR, { recursive: true });

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, "{}");
}

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 20 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large."));
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeUsers(users) {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify(users, null, 2),
    "utf8"
  );
}

// --------------------------------------------------
// Password hashing
// --------------------------------------------------

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");

  return {
    salt,
    hash,
  };
}

function verifyPassword(password, salt, storedHash) {
  const derivedHash = crypto.scryptSync(
    password,
    salt,
    64
  );

  const storedBuffer = Buffer.from(storedHash, "hex");

  return (
    storedBuffer.length === derivedHash.length &&
    crypto.timingSafeEqual(storedBuffer, derivedHash)
  );
}

// --------------------------------------------------
// Username / filename helpers
// --------------------------------------------------

function safeUsername(username) {
  return String(username || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
}

function safeTextFilename(text) {
  let name = String(text || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) {
    name = "Untitled";
  }

  name = name.slice(0, 80).trim();

  // Windows reserved filenames
  if (
    /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(name)
  ) {
    name = "_" + name;
  }

  return name;
}

// --------------------------------------------------
// User storage
// --------------------------------------------------

function userDir(username) {
  return path.join(USERS_DIR, username);
}

function notesDir(username) {
  return path.join(userDir(username), "notes");
}

function uploadsDir(username) {
  return path.join(userDir(username), "uploads");
}

function ensureUserDirs(username) {
  fs.mkdirSync(notesDir(username), { recursive: true });
  fs.mkdirSync(uploadsDir(username), { recursive: true });
}

// --------------------------------------------------
// Unique note filename
// --------------------------------------------------

function uniqueNoteFile(username, baseName) {
  const directory = notesDir(username);

  let filename = `${baseName}.txt`;
  let counter = 2;

  while (fs.existsSync(path.join(directory, filename))) {
    filename = `${baseName}-${counter}.txt`;
    counter++;
  }

  return path.join(directory, filename);
}

// --------------------------------------------------
// Sessions
// --------------------------------------------------

const sessions = new Map();

function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");

  sessions.set(token, username);

  return token;
}

function setCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `session=${token}; HttpOnly; Path=/; SameSite=Lax`
  );
}

function clearCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
  );
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};

  header.split(";").forEach(part => {
    const index = part.indexOf("=");

    if (index === -1) return;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

function currentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.session;

  if (!token) {
    return null;
  }

  return sessions.get(token) || null;
}

function requireUser(req, res) {
  const username = currentUser(req);

  if (!username) {
    sendJson(res, 401, {
      error: "You must be logged in."
    });

    return null;
  }

  return username;
}

// --------------------------------------------------
// Image saving
// --------------------------------------------------

function saveImage(username, imageData) {
  if (!imageData) {
    return null;
  }

  const match = String(imageData).match(
    /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/
  );

  if (!match) {
    return null;
  }

  const extension =
    match[1] === "jpeg"
      ? "jpg"
      : match[1];

  const filename =
    `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension}`;

  const filepath = path.join(
    uploadsDir(username),
    filename
  );

  fs.writeFileSync(
    filepath,
    Buffer.from(match[2], "base64")
  );

  return filename;
}

// --------------------------------------------------
// Read user's clips
// --------------------------------------------------

function readClips(username) {
  ensureUserDirs(username);

  const clips = [];

  // Text notes
  const noteFiles = fs
    .readdirSync(notesDir(username))
    .filter(file => file.toLowerCase().endsWith(".txt"));

  for (const file of noteFiles) {
    const filepath = path.join(notesDir(username), file);

    try {
      const text = fs.readFileSync(filepath, "utf8");

      clips.push({
        id: `text:${file}`,
        type: "text",
        text,
        filename: file,
        created: fs.statSync(filepath).birthtimeMs || Date.now()
      });
    } catch {
      // Ignore unreadable files
    }
  }

  // Images
  const imageFiles = fs
    .readdirSync(uploadsDir(username))
    .filter(file =>
      /\.(png|jpg|jpeg|webp|gif)$/i.test(file)
    );

  for (const file of imageFiles) {
    const filepath = path.join(
      uploadsDir(username),
      file
    );

    clips.push({
      id: `image:${file}`,
      type: "image",
      image: `/uploads/${encodeURIComponent(username)}/${encodeURIComponent(file)}`,
      filename: file,
      created: fs.statSync(filepath).birthtimeMs || Date.now()
    });
  }

  clips.sort((a, b) => b.created - a.created);

  return clips;
}

// --------------------------------------------------
// HTTP server
// --------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    const method = req.method;
    const pathname = url.pathname;

    // ------------------------------------------------
    // SIGN UP
    // ------------------------------------------------

    if (method === "POST" && pathname === "/api/signup") {
      const body = await readBody(req);

      const username = safeUsername(body.username);
      const password = String(body.password || "");

      if (!username) {
        return sendJson(res, 400, {
          error: "Username is required."
        });
      }

      if (password.length < 4) {
        return sendJson(res, 400, {
          error: "Password must be at least 4 characters."
        });
      }

      const users = readUsers();

      if (users[username]) {
        return sendJson(res, 409, {
          error: "Username already exists."
        });
      }

      const { salt, hash } = hashPassword(password);

      users[username] = {
        salt,
        hash,
        created: new Date().toISOString()
      };

      writeUsers(users);
      ensureUserDirs(username);

      const token = createSession(username);

      setCookie(res, token);

      return sendJson(res, 201, {
        ok: true,
        username
      });
    }

    // ------------------------------------------------
    // LOGIN
    // ------------------------------------------------

    if (method === "POST" && pathname === "/api/login") {
      const body = await readBody(req);

      const username = safeUsername(body.username);
      const password = String(body.password || "");

      const users = readUsers();
      const user = users[username];

      if (!user) {
        return sendJson(res, 401, {
          error: "Invalid username or password."
        });
      }

      if (
        !verifyPassword(
          password,
          user.salt,
          user.hash
        )
      ) {
        return sendJson(res, 401, {
          error: "Invalid username or password."
        });
      }

      ensureUserDirs(username);

      const token = createSession(username);

      setCookie(res, token);

      return sendJson(res, 200, {
        ok: true,
        username
      });
    }

    // ------------------------------------------------
    // LOGOUT
    // ------------------------------------------------

    if (method === "POST" && pathname === "/api/logout") {
      const cookies = parseCookies(req);
      const token = cookies.session;

      if (token) {
        sessions.delete(token);
      }

      clearCookie(res);

      return sendJson(res, 200, {
        ok: true
      });
    }

    // ------------------------------------------------
    // CURRENT USER
    // ------------------------------------------------

    if (method === "GET" && pathname === "/api/me") {
      const username = currentUser(req);

      return sendJson(res, 200, {
        loggedIn: !!username,
        username: username || null
      });
    }

    // ------------------------------------------------
    // DELETE ACCOUNT
    // ------------------------------------------------

    if (
      method === "POST" &&
      pathname === "/api/delete-account"
    ) {
      const username = requireUser(req, res);

      if (!username) {
        return;
      }

      const users = readUsers();

      if (!users[username]) {
        clearCookie(res);

        return sendJson(res, 404, {
          error: "Account not found."
        });
      }

      // Remove the account from users.json
      delete users[username];
      writeUsers(users);

      // Remove ALL notes and uploaded images
      // belonging to this user.
      fs.rmSync(
        userDir(username),
        {
          recursive: true,
          force: true
        }
      );

      // Invalidate every active session
      // belonging to this user.
      for (const [
        token,
        sessionUsername
      ] of sessions.entries()) {
        if (sessionUsername === username) {
          sessions.delete(token);
        }
      }

      clearCookie(res);

      return sendJson(res, 200, {
        ok: true
      });
    }

    // ------------------------------------------------
    // GET CLIPS
    // ------------------------------------------------

    if (
      method === "GET" &&
      pathname === "/api/clips"
    ) {
      const username = requireUser(req, res);

      if (!username) {
        return;
      }

      return sendJson(res, 200, {
        clips: readClips(username)
      });
    }

    // ------------------------------------------------
    // CREATE CLIP
    // ------------------------------------------------

    if (
      method === "POST" &&
      pathname === "/api/clips"
    ) {
      const username = requireUser(req, res);

      if (!username) {
        return;
      }

      const body = await readBody(req);

      const text =
        typeof body.text === "string"
          ? body.text.trim()
          : "";

      const image =
        typeof body.image === "string"
          ? body.image
          : null;

      ensureUserDirs(username);

      let noteFile = null;
      let imageFile = null;

      // Save text as a .txt file.
      // Filename uses the FIRST WORD.
      if (text) {
        const firstWord =
          text.split(/\s+/)[0];

        const baseName =
          safeTextFilename(firstWord);

        noteFile =
          uniqueNoteFile(
            username,
            baseName
          );

        fs.writeFileSync(
          noteFile,
          text,
          "utf8"
        );
      }

      // Save image if supplied.
      if (image) {
        imageFile =
          saveImage(
            username,
            image
          );
      }

      return sendJson(res, 201, {
        ok: true,
        noteFile: noteFile
          ? path.basename(noteFile)
          : null,
        imageFile
      });
    }

    // ------------------------------------------------
    // DELETE CLIP
    // ------------------------------------------------

    if (
      method === "DELETE" &&
      pathname.startsWith("/api/clips/")
    ) {
      const username = requireUser(req, res);

      if (!username) {
        return;
      }

      const id =
        decodeURIComponent(
          pathname.slice("/api/clips/".length)
        );

      if (id.startsWith("text:")) {
        const filename =
          path.basename(
            id.slice("text:".length)
          );

        const filepath =
          path.join(
            notesDir(username),
            filename
          );

        if (fs.existsSync(filepath)) {
          fs.unlinkSync(filepath);
        }
      }

      if (id.startsWith("image:")) {
        const filename =
          path.basename(
            id.slice("image:".length)
          );

        const filepath =
          path.join(
            uploadsDir(username),
            filename
          );

        if (fs.existsSync(filepath)) {
          fs.unlinkSync(filepath);
        }
      }

      return sendJson(res, 200, {
        ok: true
      });
    }

    // ------------------------------------------------
    // USER UPLOADS
    // ------------------------------------------------

    if (
      method === "GET" &&
      pathname.startsWith("/uploads/")
    ) {
      const username = currentUser(req);

      if (!username) {
        return sendJson(res, 401, {
          error: "Not logged in."
        });
      }

      const parts =
        pathname
          .slice("/uploads/".length)
          .split("/");

      const requestedUsername =
        decodeURIComponent(parts.shift() || "");

      if (requestedUsername !== username) {
        return sendJson(res, 403, {
          error: "Forbidden."
        });
      }

      const filename =
        decodeURIComponent(
          parts.join("/")
        );

      const safeFilename =
        path.basename(filename);

      const filepath =
        path.join(
          uploadsDir(username),
          safeFilename
        );

      if (!fs.existsSync(filepath)) {
        return sendJson(res, 404, {
          error: "File not found."
        });
      }

      const extension =
        path.extname(filepath)
          .toLowerCase();

      const contentTypes = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif"
      };

      res.writeHead(200, {
        "Content-Type":
          contentTypes[extension] ||
          "application/octet-stream",
        "Cache-Control": "private, max-age=3600"
      });

      return fs.createReadStream(filepath)
        .pipe(res);
    }

    // ------------------------------------------------
    // STATIC FRONTEND
    // ------------------------------------------------

    let filePath =
      pathname === "/"
        ? path.join(PUBLIC_DIR, "index.html")
        : path.join(
            PUBLIC_DIR,
            pathname.replace(/^\/+/, "")
          );

    filePath =
      path.normalize(filePath);

    if (
      !filePath.startsWith(
        path.normalize(PUBLIC_DIR + path.sep)
      ) &&
      filePath !== path.join(
        PUBLIC_DIR,
        "index.html"
      )
    ) {
      return sendJson(res, 403, {
        error: "Forbidden."
      });
    }

    if (!fs.existsSync(filePath)) {
      return sendJson(res, 404, {
        error: "Not found."
      });
    }

    const extension =
      path.extname(filePath)
        .toLowerCase();

    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".ico": "image/x-icon"
    };

    res.writeHead(200, {
      "Content-Type":
        contentTypes[extension] ||
        "application/octet-stream"
    });

    fs.createReadStream(filePath)
      .pipe(res);

  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      sendJson(res, 500, {
        error: "Internal server error."
      });
    } else {
      res.end();
    }
  }
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

server.listen(PORT, () => {
  console.log(
    `Field Notes server running on port ${PORT}`
  );
});
