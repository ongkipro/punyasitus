/**
 * Ready-to-Import Google Tag Manager Container Template & CI Structural Validator
 * (`packages/core/src/analytics/gtm-template.ts`; TASK-076, REQ-027, PLAN §18.1).
 *
 * Matches `docs/gtm/punyasitus-container-template-v1.json` byte-for-byte so Cloudflare
 * Workers can serve the downloadable container JSON without filesystem access, while CI
 * tests verify exact parity and structural validity against GTM Export Format Version 2.
 */

import { GTM_DATALAYER_EVENTS, type GtmDataLayerEventName } from "./gtm.ts";

export const GTM_TEMPLATE_FILENAME = "punyasitus-gtm-container-template-v1.json" as const;

export const GTM_TEMPLATE_PLACEHOLDER_IDS = Object.freeze({
  ga4: "G-XXXXXXXXXX",
  meta: "000000000000000",
  tiktok: "C0000000000000000000",
});

export interface GtmContainerTemplateParameter {
  readonly type: "TEMPLATE" | "BOOLEAN" | "LIST" | "MAP";
  readonly key: string;
  readonly value?: string;
  readonly list?: readonly GtmContainerTemplateParameter[];
  readonly map?: readonly GtmContainerTemplateParameter[];
}

export interface GtmContainerTemplateVariable {
  readonly accountId: string;
  readonly containerId: string;
  readonly variableId: string;
  readonly name: string;
  readonly type: string;
  readonly parameter: readonly GtmContainerTemplateParameter[];
}

export interface GtmContainerTemplateTrigger {
  readonly accountId: string;
  readonly containerId: string;
  readonly triggerId: string;
  readonly name: string;
  readonly type: string;
  readonly customEventFilter?: readonly {
    readonly type: string;
    readonly parameter: readonly GtmContainerTemplateParameter[];
  }[];
}

export interface GtmContainerTemplateTag {
  readonly accountId: string;
  readonly containerId: string;
  readonly tagId: string;
  readonly name: string;
  readonly type: string;
  readonly parameter: readonly GtmContainerTemplateParameter[];
  readonly firingTriggerId: readonly string[];
  readonly tagFiringOption: string;
  readonly consentSettings: {
    readonly consentStatus: "NEEDED" | "NOT_NEEDED";
    readonly consentType?: {
      readonly type: "LIST";
      readonly list: readonly { readonly type: "TEMPLATE"; readonly value: string }[];
    };
  };
}

export interface GtmContainerTemplateDocument {
  readonly exportFormatVersion: 2;
  readonly exportTime: string;
  readonly containerVersion: {
    readonly path: string;
    readonly accountId: string;
    readonly containerId: string;
    readonly containerVersionId: string;
    readonly name: string;
    readonly description: string;
    readonly container: {
      readonly path: string;
      readonly accountId: string;
      readonly containerId: string;
      readonly name: string;
      readonly publicId: string;
      readonly usageContext: readonly ["WEB"];
    };
    readonly tag: readonly GtmContainerTemplateTag[];
    readonly trigger: readonly GtmContainerTemplateTrigger[];
    readonly variable: readonly GtmContainerTemplateVariable[];
    readonly builtInVariable: readonly {
      readonly accountId: string;
      readonly containerId: string;
      readonly type: string;
      readonly name: string;
    }[];
  };
}

function makeConstantVariable(
  variableId: string,
  name: string,
  value: string,
): GtmContainerTemplateVariable {
  return {
    accountId: "0",
    containerId: "0",
    variableId,
    name,
    type: "c",
    parameter: [{ type: "TEMPLATE", key: "value", value }],
  };
}

function makeDataLayerVariable(
  variableId: string,
  name: string,
  dlKey: string,
): GtmContainerTemplateVariable {
  return {
    accountId: "0",
    containerId: "0",
    variableId,
    name,
    type: "v",
    parameter: [
      { type: "TEMPLATE", key: "dataLayerVersion", value: "2" },
      { type: "BOOLEAN", key: "setDefaultValue", value: "false" },
      { type: "TEMPLATE", key: "name", value: dlKey },
    ],
  };
}

function makeCustomEventTrigger(
  triggerId: string,
  name: string,
  eventName: GtmDataLayerEventName,
): GtmContainerTemplateTrigger {
  return {
    accountId: "0",
    containerId: "0",
    triggerId,
    name,
    type: "CUSTOM_EVENT",
    customEventFilter: [
      {
        type: "EQUALS",
        parameter: [
          { type: "TEMPLATE", key: "arg0", value: "{{_event}}" },
          { type: "TEMPLATE", key: "arg1", value: eventName },
        ],
      },
    ],
  };
}

function consentList(types: readonly string[]) {
  return {
    consentStatus: "NEEDED" as const,
    consentType: {
      type: "LIST" as const,
      list: types.map((value) => ({ type: "TEMPLATE" as const, value })),
    },
  };
}

export const PUNYASITUS_GTM_CONTAINER_TEMPLATE: GtmContainerTemplateDocument = {
  exportFormatVersion: 2,
  exportTime: "2026-11-23 00:00:00",
  containerVersion: {
    path: "accounts/0/containers/0/versions/0",
    accountId: "0",
    containerId: "0",
    containerVersionId: "1",
    name: "PunyaSitus Standard Tracking Template v1",
    description:
      "Template kontainer GTM resmi PunyaSitus (REQ-027, dataLayer ps_* v1). Gunakan Admin > Import Container > Merge ke workspace baru, lalu ganti variabel konstanta GA4 / Meta Pixel / TikTok Pixel dengan ID asli Anda.",
    container: {
      path: "accounts/0/containers/0",
      accountId: "0",
      containerId: "0",
      name: "PunyaSitus Website Template",
      publicId: "GTM-XXXXXXX",
      usageContext: ["WEB"],
    },
    builtInVariable: [
      { accountId: "0", containerId: "0", type: "EVENT", name: "Event" },
      { accountId: "0", containerId: "0", type: "PAGE_PATH", name: "Page Path" },
      { accountId: "0", containerId: "0", type: "PAGE_HOSTNAME", name: "Page Hostname" },
    ],
    variable: [
      // Placeholder constant variables — tenant replaces ONLY the vendors routed via GTM
      makeConstantVariable("1", "PS - GA4 Measurement ID", GTM_TEMPLATE_PLACEHOLDER_IDS.ga4),
      makeConstantVariable("2", "PS - Meta Pixel ID", GTM_TEMPLATE_PLACEHOLDER_IDS.meta),
      makeConstantVariable("3", "PS - TikTok Pixel ID", GTM_TEMPLATE_PLACEHOLDER_IDS.tiktok),
      // Standard PII-free `ps_*` dataLayer variables (version 1)
      makeDataLayerVariable("4", "DLV - ps_schema_version", "ps_schema_version"),
      makeDataLayerVariable("5", "DLV - event_id", "event_id"),
      makeDataLayerVariable("6", "DLV - page_type", "page_type"),
      makeDataLayerVariable("7", "DLV - content_id", "content_id"),
      makeDataLayerVariable("8", "DLV - page_path", "page_path"),
      makeDataLayerVariable("9", "DLV - item_id", "item_id"),
      makeDataLayerVariable("10", "DLV - item_title", "item_title"),
      makeDataLayerVariable("11", "DLV - placement", "placement"),
      makeDataLayerVariable("12", "DLV - destination_host", "destination_host"),
      makeDataLayerVariable("13", "DLV - form_id", "form_id"),
    ],
    trigger: [
      makeCustomEventTrigger("101", "PS Trigger - Page View (ps_page_view)", "ps_page_view"),
      makeCustomEventTrigger("102", "PS Trigger - WhatsApp Click (ps_wa_click)", "ps_wa_click"),
      makeCustomEventTrigger(
        "103",
        "PS Trigger - External Click (ps_external_click)",
        "ps_external_click",
      ),
      makeCustomEventTrigger(
        "104",
        "PS Trigger - Lead Submitted (ps_lead_submitted)",
        "ps_lead_submitted",
      ),
    ],
    tag: [
      // --- GA4 Tags (Consent: analytics_storage) ---
      {
        accountId: "0",
        containerId: "0",
        tagId: "201",
        name: "PS - GA4 Configuration",
        type: "googtag",
        parameter: [
          { type: "TEMPLATE", key: "tagId", value: "{{PS - GA4 Measurement ID}}" },
          {
            type: "LIST",
            key: "configSettingsTable",
            list: [
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "send_page_view" },
                  { type: "TEMPLATE", key: "parameterValue", value: "false" },
                ],
              },
            ],
          },
        ],
        firingTriggerId: ["101"],
        tagFiringOption: "ONCE_PER_LOAD",
        consentSettings: consentList(["analytics_storage"]),
      },
      {
        accountId: "0",
        containerId: "0",
        tagId: "202",
        name: "PS - GA4 Event - Page View",
        type: "gaawe",
        parameter: [
          { type: "TEMPLATE", key: "measurementIdOverride", value: "{{PS - GA4 Measurement ID}}" },
          { type: "TEMPLATE", key: "eventName", value: "page_view" },
          {
            type: "LIST",
            key: "eventSettingsTable",
            list: [
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "page_type" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - page_type}}" },
                ],
              },
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "content_id" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - content_id}}" },
                ],
              },
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "event_id" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - event_id}}" },
                ],
              },
            ],
          },
        ],
        firingTriggerId: ["101"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["analytics_storage"]),
      },
      {
        accountId: "0",
        containerId: "0",
        tagId: "203",
        name: "PS - GA4 Event - WhatsApp Click",
        type: "gaawe",
        parameter: [
          { type: "TEMPLATE", key: "measurementIdOverride", value: "{{PS - GA4 Measurement ID}}" },
          { type: "TEMPLATE", key: "eventName", value: "whatsapp_click" },
          {
            type: "LIST",
            key: "eventSettingsTable",
            list: [
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "item_id" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - item_id}}" },
                ],
              },
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "item_title" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - item_title}}" },
                ],
              },
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "placement" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - placement}}" },
                ],
              },
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "event_id" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - event_id}}" },
                ],
              },
            ],
          },
        ],
        firingTriggerId: ["102"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["analytics_storage"]),
      },
      {
        accountId: "0",
        containerId: "0",
        tagId: "204",
        name: "PS - GA4 Event - External Click",
        type: "gaawe",
        parameter: [
          { type: "TEMPLATE", key: "measurementIdOverride", value: "{{PS - GA4 Measurement ID}}" },
          { type: "TEMPLATE", key: "eventName", value: "external_click" },
          {
            type: "LIST",
            key: "eventSettingsTable",
            list: [
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "item_id" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - item_id}}" },
                ],
              },
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "destination_host" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - destination_host}}" },
                ],
              },
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "event_id" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - event_id}}" },
                ],
              },
            ],
          },
        ],
        firingTriggerId: ["103"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["analytics_storage"]),
      },
      {
        accountId: "0",
        containerId: "0",
        tagId: "205",
        name: "PS - GA4 Event - Lead Submitted",
        type: "gaawe",
        parameter: [
          { type: "TEMPLATE", key: "measurementIdOverride", value: "{{PS - GA4 Measurement ID}}" },
          { type: "TEMPLATE", key: "eventName", value: "generate_lead" },
          {
            type: "LIST",
            key: "eventSettingsTable",
            list: [
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "form_id" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - form_id}}" },
                ],
              },
              {
                type: "MAP",
                key: "row",
                map: [
                  { type: "TEMPLATE", key: "parameter", value: "event_id" },
                  { type: "TEMPLATE", key: "parameterValue", value: "{{DLV - event_id}}" },
                ],
              },
            ],
          },
        ],
        firingTriggerId: ["104"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["analytics_storage"]),
      },
      // --- Meta Pixel Tags (Consent: ad_storage, ad_user_data) ---
      {
        accountId: "0",
        containerId: "0",
        tagId: "301",
        name: "PS - Meta Pixel - Base & PageView",
        type: "html",
        parameter: [
          {
            type: "TEMPLATE",
            key: "html",
            value:
              "<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','{{PS - Meta Pixel ID}}');fbq('track','PageView',{},{eventID:'{{DLV - event_id}}'});</script>",
          },
          { type: "BOOLEAN", key: "supportDocumentWrite", value: "false" },
        ],
        firingTriggerId: ["101"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["ad_storage", "ad_user_data"]),
      },
      {
        accountId: "0",
        containerId: "0",
        tagId: "302",
        name: "PS - Meta Pixel - WhatsApp Contact",
        type: "html",
        parameter: [
          {
            type: "TEMPLATE",
            key: "html",
            value:
              "<script>if(window.fbq){fbq('track','Contact',{content_name:'{{DLV - item_title}}',content_category:'{{DLV - placement}}'},{eventID:'{{DLV - event_id}}'});}</script>",
          },
          { type: "BOOLEAN", key: "supportDocumentWrite", value: "false" },
        ],
        firingTriggerId: ["102"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["ad_storage", "ad_user_data"]),
      },
      {
        accountId: "0",
        containerId: "0",
        tagId: "303",
        name: "PS - Meta Pixel - External ViewContent",
        type: "html",
        parameter: [
          {
            type: "TEMPLATE",
            key: "html",
            value:
              "<script>if(window.fbq){fbq('track','ViewContent',{content_category:'{{DLV - destination_host}}'},{eventID:'{{DLV - event_id}}'});}</script>",
          },
          { type: "BOOLEAN", key: "supportDocumentWrite", value: "false" },
        ],
        firingTriggerId: ["103"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["ad_storage", "ad_user_data"]),
      },
      {
        accountId: "0",
        containerId: "0",
        tagId: "304",
        name: "PS - Meta Pixel - Lead Submitted",
        type: "html",
        parameter: [
          {
            type: "TEMPLATE",
            key: "html",
            value:
              "<script>if(window.fbq){fbq('track','Lead',{content_name:'{{DLV - form_id}}'},{eventID:'{{DLV - event_id}}'});}</script>",
          },
          { type: "BOOLEAN", key: "supportDocumentWrite", value: "false" },
        ],
        firingTriggerId: ["104"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["ad_storage", "ad_user_data"]),
      },
      // --- TikTok Pixel Tags (Consent: ad_storage, ad_user_data) ---
      {
        accountId: "0",
        containerId: "0",
        tagId: "401",
        name: "PS - TikTok Pixel - Base & PageView",
        type: "html",
        parameter: [
          {
            type: "TEMPLATE",
            key: "html",
            value:
              "<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie','holdConsent','revokeConsent','grantConsent'];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.load=function(e,n){var r='https://analytics.tiktok.com/i18n/pixel/events.js';ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=r;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var a=d.createElement('script');a.type='text/javascript';a.async=!0;a.src=r+'?sdkid='+e+'&lib='+t;var s=d.getElementsByTagName('script')[0];s.parentNode.insertBefore(a,s)};ttq.load('{{PS - TikTok Pixel ID}}');ttq.page();}(window,document,'ttq');</script>",
          },
          { type: "BOOLEAN", key: "supportDocumentWrite", value: "false" },
        ],
        firingTriggerId: ["101"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["ad_storage", "ad_user_data"]),
      },
      {
        accountId: "0",
        containerId: "0",
        tagId: "402",
        name: "PS - TikTok Pixel - WhatsApp Contact",
        type: "html",
        parameter: [
          {
            type: "TEMPLATE",
            key: "html",
            value:
              "<script>if(window.ttq){ttq.track('Contact',{content_name:'{{DLV - item_title}}',content_category:'{{DLV - placement}}'},{event_id:'{{DLV - event_id}}'});}</script>",
          },
          { type: "BOOLEAN", key: "supportDocumentWrite", value: "false" },
        ],
        firingTriggerId: ["102"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["ad_storage", "ad_user_data"]),
      },
      {
        accountId: "0",
        containerId: "0",
        tagId: "403",
        name: "PS - TikTok Pixel - External ClickButton",
        type: "html",
        parameter: [
          {
            type: "TEMPLATE",
            key: "html",
            value:
              "<script>if(window.ttq){ttq.track('ClickButton',{content_category:'{{DLV - destination_host}}'},{event_id:'{{DLV - event_id}}'});}</script>",
          },
          { type: "BOOLEAN", key: "supportDocumentWrite", value: "false" },
        ],
        firingTriggerId: ["103"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["ad_storage", "ad_user_data"]),
      },
      {
        accountId: "0",
        containerId: "0",
        tagId: "404",
        name: "PS - TikTok Pixel - Lead SubmitForm",
        type: "html",
        parameter: [
          {
            type: "TEMPLATE",
            key: "html",
            value:
              "<script>if(window.ttq){ttq.track('SubmitForm',{content_name:'{{DLV - form_id}}'},{event_id:'{{DLV - event_id}}'});}</script>",
          },
          { type: "BOOLEAN", key: "supportDocumentWrite", value: "false" },
        ],
        firingTriggerId: ["104"],
        tagFiringOption: "ONCE_PER_EVENT",
        consentSettings: consentList(["ad_storage", "ad_user_data"]),
      },
    ],
  },
};

export function serializeGtmContainerTemplateJson(): string {
  return `${JSON.stringify(PUNYASITUS_GTM_CONTAINER_TEMPLATE, null, 2)}\n`;
}

export interface GtmTemplateValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const REQUIRED_DATALAYER_KEYS = [
  "ps_schema_version",
  "event_id",
  "page_type",
  "content_id",
  "page_path",
  "item_id",
  "item_title",
  "placement",
  "destination_host",
  "form_id",
] as const;

const FORBIDDEN_PII_TEMPLATE_KEYS = new Set([
  "email",
  "phone",
  "name",
  "fullname",
  "message",
  "whatsapp",
  "address",
]);

/**
 * CI structural validator for the committed GTM container JSON template (`docs/gtm/`).
 * Ensures Export Format v2 integrity, all 4 `ps_*` triggers, all documented dataLayer
 * variables, placeholder vendor IDs (zero real IDs), GA4/Meta/TikTok tags with Consent Mode
 * checks, and zero PII variable references.
 */
export function validateGtmContainerTemplateJson(raw: unknown): GtmTemplateValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, errors: ["Template root must be a JSON object."] };
  }

  const doc = raw as Record<string, unknown>;
  if (doc.exportFormatVersion !== 2) {
    errors.push("exportFormatVersion must be 2.");
  }

  const cv = doc.containerVersion as Record<string, unknown> | undefined;
  if (!cv || typeof cv !== "object" || Array.isArray(cv)) {
    return { valid: false, errors: [...errors, "containerVersion must be an object."] };
  }

  const container = cv.container as Record<string, unknown> | undefined;
  if (
    !container ||
    !Array.isArray(container.usageContext) ||
    !container.usageContext.includes("WEB")
  ) {
    errors.push('containerVersion.container.usageContext must include "WEB".');
  }

  const variables = Array.isArray(cv.variable) ? (cv.variable as Record<string, unknown>[]) : [];
  const triggers = Array.isArray(cv.trigger) ? (cv.trigger as Record<string, unknown>[]) : [];
  const tags = Array.isArray(cv.tag) ? (cv.tag as Record<string, unknown>[]) : [];

  // 1. Verify all 4 standard `ps_*` Custom Event triggers exist
  const triggerEvents = new Set<string>();
  const triggerIds = new Set<string>();
  for (const trig of triggers) {
    if (typeof trig.triggerId === "string") triggerIds.add(trig.triggerId);
    if (trig.type === "CUSTOM_EVENT" && Array.isArray(trig.customEventFilter)) {
      for (const filter of trig.customEventFilter as Record<string, unknown>[]) {
        const params = Array.isArray(filter.parameter)
          ? (filter.parameter as Record<string, unknown>[])
          : [];
        const arg1 = params.find((p) => p.key === "arg1");
        if (typeof arg1?.value === "string") {
          triggerEvents.add(arg1.value);
        }
      }
    }
  }
  for (const requiredEvent of GTM_DATALAYER_EVENTS) {
    if (!triggerEvents.has(requiredEvent)) {
      errors.push(`Missing CUSTOM_EVENT trigger for "${requiredEvent}".`);
    }
  }

  // 2. Verify all required dataLayer variables exist and zero PII variables exist
  const dlKeys = new Set<string>();
  const constValues = new Map<string, string>();
  for (const v of variables) {
    const params = Array.isArray(v.parameter) ? (v.parameter as Record<string, unknown>[]) : [];
    if (v.type === "v") {
      const nameParam = params.find((p) => p.key === "name");
      if (typeof nameParam?.value === "string") {
        dlKeys.add(nameParam.value);
        if (FORBIDDEN_PII_TEMPLATE_KEYS.has(nameParam.value.toLowerCase())) {
          errors.push(`Forbidden PII dataLayer variable "${nameParam.value}" found.`);
        }
      }
    }
    if (v.type === "c" && typeof v.name === "string") {
      const valParam = params.find((p) => p.key === "value");
      if (typeof valParam?.value === "string") {
        constValues.set(v.name, valParam.value);
      }
    }
  }
  for (const key of REQUIRED_DATALAYER_KEYS) {
    if (!dlKeys.has(key)) {
      errors.push(`Missing dataLayer variable for "${key}".`);
    }
  }
  if (constValues.get("PS - GA4 Measurement ID") !== GTM_TEMPLATE_PLACEHOLDER_IDS.ga4) {
    errors.push("GA4 constant variable must use placeholder G-XXXXXXXXXX.");
  }
  if (constValues.get("PS - Meta Pixel ID") !== GTM_TEMPLATE_PLACEHOLDER_IDS.meta) {
    errors.push("Meta Pixel constant variable must use placeholder 000000000000000.");
  }
  if (constValues.get("PS - TikTok Pixel ID") !== GTM_TEMPLATE_PLACEHOLDER_IDS.tiktok) {
    errors.push("TikTok Pixel constant variable must use placeholder C0000000000000000000.");
  }

  // 3. Verify GA4, Meta Pixel, and TikTok Pixel tags exist, reference valid triggers, and require consent
  let hasGa4Tag = false;
  let hasMetaTag = false;
  let hasTiktokTag = false;

  for (const tag of tags) {
    const tagName = typeof tag.name === "string" ? tag.name : "";
    if (tagName.includes("GA4")) hasGa4Tag = true;
    if (tagName.includes("Meta Pixel")) hasMetaTag = true;
    if (tagName.includes("TikTok Pixel")) hasTiktokTag = true;

    const firing = Array.isArray(tag.firingTriggerId) ? (tag.firingTriggerId as string[]) : [];
    if (firing.length === 0) {
      errors.push(`Tag "${tagName}" has no firingTriggerId.`);
    }
    for (const tid of firing) {
      if (!triggerIds.has(tid)) {
        errors.push(`Tag "${tagName}" references unknown triggerId "${tid}".`);
      }
    }

    const consent = tag.consentSettings as Record<string, unknown> | undefined;
    if (!consent || consent.consentStatus !== "NEEDED") {
      errors.push(`Tag "${tagName}" must require Consent Mode (consentStatus: "NEEDED").`);
    }
  }

  if (!hasGa4Tag) errors.push("Template must include GA4 tags.");
  if (!hasMetaTag) errors.push("Template must include Meta Pixel tags.");
  if (!hasTiktokTag) errors.push("Template must include TikTok Pixel tags.");

  return {
    valid: errors.length === 0,
    errors,
  };
}
