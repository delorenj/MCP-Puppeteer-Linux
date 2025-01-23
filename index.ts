#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import puppeteer from "puppeteer";
import { platform } from 'os';
import { execSync } from 'child_process';

// Function to detect X11 environment
function getX11Environment() {
  if (platform() !== 'linux') return process.env;

  try {
    // Try to get the current user
    const username = execSync('whoami').toString().trim();

    // First, check for KDE's kwin_x11
    let psOutput = execSync(`ps aux | grep -i "kwin_x11" | grep "${username}"`).toString();
    let lines = psOutput.split('\n').filter(line => line && !line.includes('grep'));

    // If no kwin_x11, look for any X session
    if (!lines.length) {
      psOutput = execSync(`ps aux | grep -i "x.*session" | grep "${username}"`).toString();
      lines = psOutput.split('\n').filter(line => line && !line.includes('grep'));
    }

    // If still nothing, check for Xorg itself
    if (!lines.length) {
      psOutput = execSync('ps aux | grep "/usr/lib/Xorg"').toString();
      lines = psOutput.split('\n').filter(line => line && !line.includes('grep'));
    }

    // Get the process ID of the first matching line
    const pid = lines[0]?.split(/\s+/)[1];

    if (!pid) {
      // Fallback to defaults if we can't find a process
      return {
        ...process.env,
        DISPLAY: ':0',
        XAUTHORITY: `/run/user/${process.getuid()}/gdm/Xauthority`
      };
    }

    // Read environment from the process
    const envOutput = execSync(`tr '\\0' '\\n' < /proc/${pid}/environ`).toString();
    const env = { ...process.env };

    // Parse all environment variables
    envOutput.split('\n').forEach(line => {
      if (line) {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=');
        env[key] = value;
      }
    });

    // Ensure critical X11 variables exist
    if (!env.DISPLAY) {
      env.DISPLAY = ':0';
    }

    // Try to find XAUTHORITY if it's not set
    if (!env.XAUTHORITY) {
      try {
        const xauthLocations = [
          `/run/user/${process.getuid()}/gdm/Xauthority`,
          `${process.env.HOME}/.Xauthority`,
          '/tmp/.docker.xauth',
          ...execSync('find /tmp -maxdepth 1 -name "xauth*" 2>/dev/null').toString().split('\n')
        ];

        for (const loc of xauthLocations) {
          if (loc && execSync(`test -f "${loc}" && echo "exists"`).toString().includes('exists')) {
            env.XAUTHORITY = loc;
            break;
          }
        }
      } catch (error) {
        console.error('Error finding XAUTHORITY:', error);
      }
    }

    return env;
  } catch (error) {
    console.error('Failed to get X11 environment:', error);
    return {
      ...process.env,
      DISPLAY: ':0'
    };
  }
}

// Get environment once at startup
const processEnvironment = getX11Environment();
console.error('X11 Environment:', {
  DISPLAY: processEnvironment.DISPLAY,
  XAUTHORITY: processEnvironment.XAUTHORITY
});

// Define the tools once to avoid repetition
const TOOLS = [
  {
    name: "puppeteer_navigate",
    description: "Navigate to a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
{
  name: "puppeteer_screenshot",
  description: "Take a screenshot of the current page or a specific element",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name for the screenshot" },
      selector: { type: "string", description: "CSS selector for element to screenshot" },
      width: { type: "number", description: "Width in pixels (default: 800)" },
      height: { type: "number", description: "Height in pixels (default: 600)" },
    },
    required: ["name"],
  },
},
{
  name: "puppeteer_click",
  description: "Click an element on the page",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector for element to click" },
    },
    required: ["selector"],
  },
},
{
  name: "puppeteer_fill",
  description: "Fill out an input field",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector for input field" },
      value: { type: "string", description: "Value to fill" },
    },
    required: ["selector", "value"],
  },
},
{
  name: "puppeteer_select",
  description: "Select an element on the page with Select tag",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector for element to select" },
      value: { type: "string", description: "Value to select" },
    },
    required: ["selector", "value"],
  },
},
{
  name: "puppeteer_hover",
  description: "Hover an element on the page",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector for element to hover" },
    },
    required: ["selector"],
  },
},
{
  name: "puppeteer_evaluate",
  description: "Execute JavaScript in the browser console",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", description: "JavaScript code to execute" },
    },
    required: ["script"],
  },
},
];

// Global state
let browser;
let page;
const consoleLogs = [];
const screenshots = new Map();

async function ensureBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: false,
      env: processEnvironment  // Pass the X11 environment variables
    });
    const pages = await browser.pages();
    page = pages[0];
    page.on("console", (msg) => {
      const logEntry = `[${msg.type()}] ${msg.text()}`;
      consoleLogs.push(logEntry);
      server.notification({
        method: "notifications/resources/updated",
        params: { uri: "console://logs" },
      });
    });
  }
  return page;
}

async function handleToolCall(name, args) {
  const page = await ensureBrowser();
  switch (name) {
    case "puppeteer_navigate":
      await page.goto(args.url);
      return {
        content: [{
          type: "text",
          text: `Navigated to ${args.url}`,
        }],
        isError: false,
      };
    case "puppeteer_screenshot": {
      const width = args.width ?? 800;
      const height = args.height ?? 600;
      await page.setViewport({ width, height });
      const screenshot = await (args.selector ?
      (await page.$(args.selector))?.screenshot({ encoding: "base64" }) :
      page.screenshot({ encoding: "base64", fullPage: false }));
      if (!screenshot) {
        return {
          content: [{
            type: "text",
            text: args.selector ? `Element not found: ${args.selector}` : "Screenshot failed",
          }],
          isError: true,
        };
      }
      screenshots.set(args.name, screenshot);
      server.notification({
        method: "notifications/resources/list_changed",
      });
      return {
        content: [
          {
            type: "text",
            text: `Screenshot '${args.name}' taken at ${width}x${height}`,
          },
          {
            type: "image",
            data: screenshot,
            mimeType: "image/png",
          },
        ],
        isError: false,
      };
    }
    case "puppeteer_click":
      try {
        await page.click(args.selector);
        return {
          content: [{
            type: "text",
            text: `Clicked: ${args.selector}`,
          }],
          isError: false,
        };
      }
      catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to click ${args.selector}: ${error.message}`,
          }],
          isError: true,
        };
      }
    case "puppeteer_fill":
      try {
        await page.waitForSelector(args.selector);
        await page.type(args.selector, args.value);
        return {
          content: [{
            type: "text",
            text: `Filled ${args.selector} with: ${args.value}`,
          }],
          isError: false,
        };
      }
      catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to fill ${args.selector}: ${error.message}`,
          }],
          isError: true,
        };
      }
    case "puppeteer_select":
      try {
        await page.waitForSelector(args.selector);
        await page.select(args.selector, args.value);
        return {
          content: [{
            type: "text",
            text: `Selected ${args.selector} with: ${args.value}`,
          }],
          isError: false,
        };
      }
      catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to select ${args.selector}: ${error.message}`,
          }],
          isError: true,
        };
      }
    case "puppeteer_hover":
      try {
        await page.waitForSelector(args.selector);
        await page.hover(args.selector);
        return {
          content: [{
            type: "text",
            text: `Hovered ${args.selector}`,
          }],
          isError: false,
        };
      }
      catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to hover ${args.selector}: ${error.message}`,
          }],
          isError: true,
        };
      }
    case "puppeteer_evaluate":
      try {
        const result = await page.evaluate((script) => {
          const logs = [];
          const originalConsole = { ...console };
          ['log', 'info', 'warn', 'error'].forEach(method => {
            console[method] = (...args) => {
              logs.push(`[${method}] ${args.join(' ')}`);
              originalConsole[method](...args);
            };
          });
          try {
            const result = eval(script);
            Object.assign(console, originalConsole);
            return { result, logs };
          }
          catch (error) {
            Object.assign(console, originalConsole);
            throw error;
          }
        }, args.script);
        return {
          content: [
            {
              type: "text",
              text: `Execution result:\n${JSON.stringify(result.result, null, 2)}\n\nConsole output:\n${result.logs.join('\n')}`,
            },
          ],
          isError: false,
        };
      }
      catch (error) {
        return {
          content: [{
            type: "text",
            text: `Script execution failed: ${error.message}`,
          }],
          isError: true,
        };
      }
    default:
      return {
        content: [{
          type: "text",
          text: `Unknown tool: ${name}`,
        }],
        isError: true,
      };
  }
}

const server = new Server({
  name: "example-servers/puppeteer",
  version: "0.1.0",
}, {
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Setup request handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "console://logs",
      mimeType: "text/plain",
      name: "Browser console logs",
    },
    ...Array.from(screenshots.keys()).map(name => ({
      uri: `screenshot://${name}`,
      mimeType: "image/png",
      name: `Screenshot: ${name}`,
    })),
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri.toString();
  if (uri === "console://logs") {
    return {
      contents: [{
        uri,
        mimeType: "text/plain",
        text: consoleLogs.join("\n"),
      }],
    };
  }
  if (uri.startsWith("screenshot://")) {
    const name = uri.split("://")[1];
    const screenshot = screenshots.get(name);
    if (screenshot) {
      return {
        contents: [{
          uri,
          mimeType: "image/png",
          blob: screenshot,
        }],
      };
    }
  }
  throw new Error(`Resource not found: ${uri}`);
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => handleToolCall(request.params.name, request.params.arguments ?? {}));

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);
