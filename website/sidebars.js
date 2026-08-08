/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    "intro",
    "getting-started",
    {
      type: "category",
      label: "Serving",
      collapsed: false,
      items: ["routing", "mock-api"],
    },
    {
      type: "category",
      label: "Sessions",
      collapsed: false,
      items: ["profiles", "agents", "mcp-integration"],
    },
    "api",
  ],
};

export default sidebars;
