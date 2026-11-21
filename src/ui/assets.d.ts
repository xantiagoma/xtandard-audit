// Asset imports resolved by Vite (the SPA and embed builds): the URL of the
// emitted file, or an inlined data URI for small assets.
declare module "*.svg" {
  const url: string;
  export default url;
}
