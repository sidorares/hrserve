// @ts-check
import { themes as prismThemes } from "prism-react-renderer";

const organizationName = "sidorares";
const projectName = "hrserve";
const repoUrl = `https://github.com/${organizationName}/${projectName}`;

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "hrserve",
  tagline: "A dev server where the browser is the server — hot patching, mock APIs and no ports",
  favicon: "img/favicon.svg",

  // GitHub Pages serves the project site from /<projectName>/
  url: `https://${organizationName}.github.io`,
  baseUrl: `/${projectName}/`,
  organizationName,
  projectName,
  trailingSlash: false,

  // A broken link should fail the build rather than ship a dead docs site
  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          // Docs-only site: no blog, docs live at the root
          routeBasePath: "/",
          sidebarPath: "./sidebars.js",
          editUrl: `${repoUrl}/tree/main/website/`,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: "hrserve",
        items: [
          { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
          { to: "/mcp-integration", label: "MCP setup", position: "left" },
          { href: `${repoUrl}`, label: "GitHub", position: "right" },
          { href: `https://www.npmjs.com/package/${projectName}`, label: "npm", position: "right" },
        ],
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "Docs",
            items: [
              { label: "Introduction", to: "/" },
              { label: "Getting started", to: "/getting-started" },
              { label: "MCP setup", to: "/mcp-integration" },
            ],
          },
          {
            title: "More",
            items: [
              { label: "GitHub", href: repoUrl },
              { label: "Issues", href: `${repoUrl}/issues` },
              { label: "npm", href: `https://www.npmjs.com/package/${projectName}` },
            ],
          },
        ],
        copyright: `MIT licensed. Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ["bash", "json", "typescript"],
      },
    }),
};

export default config;
