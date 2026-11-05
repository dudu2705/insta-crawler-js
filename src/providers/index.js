import { ApifyProvider } from "./apify.js";
import { HikerApiProvider } from "./hikerapi.js";
import { SocialCrawlProvider } from "./socialcrawl.js";

export { CAPABILITIES, CapabilityNotSupportedError, InstagramDataProvider, ProviderRequestError, ProviderResult } from "./base.js";

export const PROVIDER_CLASSES = {
  apify: ApifyProvider,
  socialcrawl: SocialCrawlProvider,
  hikerapi: HikerApiProvider,
};
