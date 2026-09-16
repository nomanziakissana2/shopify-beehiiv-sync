// main.ts
// Shopify checkout_completed -> Deno Deploy -> beehiiv
//
// Endpoint:
//   POST /shopify-purchase
//
// Environment variables:
//   BEEHIIV_API_KEY            required, secret
//   BEEHIIV_PUBLICATION_ID     required
//   BEEHIIV_SHOPIFY_AUTOMATION_ID  optional
//   BEEHIIV_DIGITAL_AUTOMATION_ID  optional
//   BEEHIIV_PRINT_AUTOMATION_ID    optional
//   REQUIRE_MARKETING_CONSENT      optional, "true" or "false" (default: "true")

const BEEHIIV_API = "https://api.beehiiv.com/v2";

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);

  // CORS preflight for Shopify Custom Pixel -> Deno cross-origin request
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  // Simple health check
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({
      ok: true,
      service: "shopify-beehiiv-sync",
    });
  }

  // Main Shopify endpoint
  if (
    request.method !== "POST" ||
    url.pathname !== "/shopify-purchase"
  ) {
    return jsonResponse(
      {
        ok: false,
        error: "Not found",
      },
      404,
    );
  }

  try {
    const env = getEnv();

    let payload: any;

    try {
      payload = await request.json();
    } catch {
      return jsonResponse(
        {
          ok: false,
          error: "Invalid JSON body.",
        },
        400,
      );
    }

    const email = clean(payload?.email).toLowerCase();

    if (!isValidEmail(email)) {
      return jsonResponse(
        {
          ok: false,
          error: "A valid customer email is required.",
        },
        400,
      );
    }

    if (!Array.isArray(payload.products)) {
      payload.products = [];
    }

    const customFields = buildCustomFields(payload);

    const automationIds =
      getAutomationIds(
        env,
        payload,
      );

    // Look up subscriber first
    const existingSubscriber =
      await getBeehiivSubscriber(env, email);

    // Avoid duplicate automation runs when the same Shopify event
    // reaches the endpoint more than once.
    if (
      existingSubscriber &&
      clean(payload.event_id) &&
      getExistingCustomField(
        existingSubscriber,
        "Last Shopify Event ID",
      ) === clean(payload.event_id)
    ) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        email,
        message: "Shopify event already processed.",
      });
    }

    // ---------------------------------------------------------
    // NEW SUBSCRIBER
    // ---------------------------------------------------------

    if (!existingSubscriber) {
      if (
        env.requireMarketingConsent &&
        payload.accepts_email_marketing !== true
      ) {
        return jsonResponse({
          ok: true,
          skipped: true,
          reason: "marketing_consent_required",
          email,
        });
      }

      const created = await createBeehiivSubscriber(
        env,
        email,
        customFields,
        automationIds,
      );

      return jsonResponse({
        ok: true,
        action: "created",
        email,
        subscription_id:
          created?.data?.id ?? null,
        warnings:
          created?.warnings ?? [],
      });
    }

    // ---------------------------------------------------------
    // EXISTING SUBSCRIBER
    // ---------------------------------------------------------

    const updated = await updateBeehiivSubscriber(
      env,
      email,
      customFields,
    );

    const automationResults: any[] = [];

    const status =
      clean(
        existingSubscriber.status,
      ).toLowerCase();

    if (
      status === "" ||
      status === "active" ||
      status === "validating"
    ) {
      for (
        const automationId
        of automationIds
      ) {
        try {
          const journey =
            await triggerBeehiivAutomation(
              env,
              email,
              automationId,
            );

          automationResults.push({
            automation_id:
              automationId,
            triggered:
              true,
            journey_id:
              journey?.data?.id ?? null,
          });
        } catch (error) {
          console.error(
            `beehiiv automation ${automationId} error:`,
            error,
          );

          automationResults.push({
            automation_id:
              automationId,
            triggered:
              false,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          });
        }
      }
    } else if (
      automationIds.length
    ) {
      automationResults.push({
        triggered:
          false,
        reason:
          `subscriber_status_${status}`,
      });
    }

    return jsonResponse({
      ok: true,
      action: "updated",
      email,
      subscription_id:
        updated?.data?.id ??
        existingSubscriber?.id ??
        null,
      automations:
        automationResults,
      warnings:
        updated?.warnings ?? [],
    });
  } catch (error) {
    console.error(
      "Shopify -> beehiiv error:",
      error,
    );

    const status =
      typeof (error as any)?.status === "number"
        ? (error as any).status
        : 500;

    return jsonResponse(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unexpected server error.",
      },
      status,
    );
  }
});


/* ============================================================
   ENVIRONMENT
============================================================ */

function getEnv() {
  const apiKey =
    Deno.env.get("BEEHIIV_API_KEY") || "";

  const publicationId =
    Deno.env.get("BEEHIIV_PUBLICATION_ID") || "";

  const shopifyAutomationId =
    Deno.env.get(
      "BEEHIIV_SHOPIFY_AUTOMATION_ID"
    ) || "";

  const digitalAutomationId =
    Deno.env.get(
      "BEEHIIV_DIGITAL_AUTOMATION_ID"
    ) || "";

  const printAutomationId =
    Deno.env.get(
      "BEEHIIV_PRINT_AUTOMATION_ID"
    ) || "";

  const requireMarketingConsent =
    (
      Deno.env.get(
        "REQUIRE_MARKETING_CONSENT"
      ) ?? "true"
    ).toLowerCase() !== "false";

  if (!apiKey) {
    throw new Error(
      "Missing BEEHIIV_API_KEY environment variable.",
    );
  }

  if (!publicationId) {
    throw new Error(
      "Missing BEEHIIV_PUBLICATION_ID environment variable.",
    );
  }

  return {
    apiKey,
    publicationId,
    shopifyAutomationId,
    digitalAutomationId,
    printAutomationId,
    requireMarketingConsent,
  };
}

/* ============================================================
   SELECT BEEHIIV AUTOMATIONS
============================================================ */

function getAutomationIds(
  env: ReturnType<typeof getEnv>,
  payload: any,
) {
  const automationIds: string[] = [];

  if (env.shopifyAutomationId) {
    automationIds.push(
      env.shopifyAutomationId,
    );
  }

  if (
    payload.has_digital_subscription === true &&
    env.digitalAutomationId
  ) {
    automationIds.push(
      env.digitalAutomationId,
    );
  }

  if (
    payload.has_print_subscription === true &&
    env.printAutomationId
  ) {
    automationIds.push(
      env.printAutomationId,
    );
  }

  return [
    ...new Set(automationIds),
  ];
}



/* ============================================================
   RESPONSE / CORS
============================================================ */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type",
    "Access-Control-Max-Age":
      "86400",
  };
}


function jsonResponse(
  data: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        ...corsHeaders(),
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control":
          "no-store",
      },
    },
  );
}


/* ============================================================
   GENERAL HELPERS
============================================================ */

function clean(value: unknown): string {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value).trim();
}


function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email,
  );
}


function unique(values: unknown[]) {
  return [
    ...new Set(
      values
        .map(clean)
        .filter(Boolean),
    ),
  ];
}


function truncate(
  value: unknown,
  maxLength = 1000,
) {
  const text = clean(value);

  if (text.length <= maxLength) {
    return text;
  }

  return (
    text.slice(
      0,
      Math.max(0, maxLength - 3),
    ) + "..."
  );
}


/* ============================================================
   SHOPIFY PAYLOAD -> BEEHIIV CUSTOM FIELDS
============================================================ */

function buildCustomFields(payload: any) {
  const products =
    Array.isArray(payload.products)
      ? payload.products
      : [];

  const productDescriptions =
    products.map((product: any) => {
      const title =
        clean(
          product.product_title ||
          product.title,
        );

      const variant =
        clean(product.variant_title);

      const quantity =
        Number(product.quantity || 1);

      const parts = [title];

      if (
        variant &&
        variant !== "Default Title"
      ) {
        parts.push(`- ${variant}`);
      }

      parts.push(`x${quantity}`);

      return parts
        .filter(Boolean)
        .join(" ");
    });

  const productIds =
    unique(
      products.map(
        (product: any) =>
          product.product_id,
      ),
    );

  const variantIds =
    unique(
      products.map(
        (product: any) =>
          product.variant_id,
      ),
    );

  const skus =
    unique(
      products.map(
        (product: any) =>
          product.sku,
      ),
    );

  const sellingPlanIds =
    unique(
      products.map(
        (product: any) =>
          product.selling_plan_id,
      ),
    );

  const sellingPlanNames =
    unique(
      products.map(
        (product: any) =>
          product.selling_plan_name,
      ),
    );

  const subscriptionProducts =
    unique(
      products
        .filter((product: any) => {
          return (
            product.is_subscription === true ||
            clean(
              product.selling_plan_name,
            )
          );
        })
        .map(
          (product: any) =>
            product.product_title ||
            product.title,
        ),
    );

  const purchaseType =
    clean(payload.purchase_type) ||
    inferPurchaseType(products);

  const fields = [
    {
      name: "First Name",
      value: clean(payload.first_name),
    },
    {
      name: "Last Name",
      value: clean(payload.last_name),
    },
    {
      name: "Phone",
      value: clean(payload.phone),
    },
    {
      name: "Shopify Customer ID",
      value: clean(payload.customer_id),
    },
    {
      name: "Last Shopify Order ID",
      value: clean(payload.order_id),
    },
    {
      name: "Last Shopify Event ID",
      value: clean(payload.event_id),
    },
    {
      name: "Last Order Total",
      value: clean(payload.total),
    },
    {
      name: "Currency",
      value: clean(payload.currency),
    },
    {
      name: "Purchase Type",
      value: purchaseType,
    },
    {
      name: "Subscription Level",
      value:
        clean(
          payload.subscription_level,
        ) ||
        sellingPlanNames.join(" | "),
    },
    {
      name: "Subscription Product",
      value:
        truncate(
          subscriptionProducts.join(
            " | ",
          ),
        ),
    },
    {
      name: "Last Products Purchased",
      value:
        truncate(
          productDescriptions.join(
            " | ",
          ),
        ),
    },
    {
      name: "Purchased Product IDs",
      value:
        truncate(
          productIds.join(" | "),
        ),
    },
    {
      name: "Purchased Variant IDs",
      value:
        truncate(
          variantIds.join(" | "),
        ),
    },
    {
      name: "Purchased SKUs",
      value:
        truncate(
          skus.join(" | "),
        ),
    },
    {
      name: "Selling Plan IDs",
      value:
        truncate(
          sellingPlanIds.join(" | "),
        ),
    },
    {
      name: "Last Purchase Date",
      value:
        clean(
          payload.event_timestamp,
        ) ||
        new Date().toISOString(),
    },
  ];

  // Prevent blank values from overwriting useful beehiiv data.
  return fields.filter(
    (field) =>
      clean(field.value) !== "",
  );
}


function inferPurchaseType(
  products: any[],
) {
  if (!products.length) {
    return "One-time purchase";
  }

  const subscriptions =
    products.filter((product: any) => {
      return (
        product.is_subscription === true ||
        clean(
          product.selling_plan_name,
        )
      );
    });

  if (!subscriptions.length) {
    return "One-time purchase";
  }

  if (
    subscriptions.length ===
    products.length
  ) {
    return "Subscription";
  }

  return "Mixed";
}


function getExistingCustomField(
  subscriber: any,
  fieldName: string,
) {
  const fields =
    Array.isArray(
      subscriber?.custom_fields,
    )
      ? subscriber.custom_fields
      : [];

  const field =
    fields.find(
      (item: any) =>
        clean(item?.name) ===
        fieldName,
    );

  return field
    ? clean(field.value)
    : "";
}


/* ============================================================
   BEEHIIV REQUEST
============================================================ */

async function beehiivRequest(
  env: ReturnType<typeof getEnv>,
  path: string,
  options: RequestInit = {},
) {
  const response =
    await fetch(
      `${BEEHIIV_API}${path}`,
      {
        ...options,
        headers: {
          Authorization:
            `Bearer ${env.apiKey}`,
          Accept:
            "application/json",
          ...(options.body
            ? {
                "Content-Type":
                  "application/json",
              }
            : {}),
          ...(options.headers || {}),
        },
      },
    );

  const raw =
    await response.text();

  let result: any = {};

  if (raw) {
    try {
      result =
        JSON.parse(raw);
    } catch {
      result = {
        raw,
      };
    }
  }

  if (!response.ok) {
    const message =
      result?.message ||
      result?.error ||
      result?.description ||
      `beehiiv API error ${response.status}`;

    const apiError: any =
      new Error(message);

    apiError.status =
      response.status;

    apiError.response =
      result;

    throw apiError;
  }

  return result;
}


/* ============================================================
   GET SUBSCRIBER BY EMAIL
============================================================ */

async function getBeehiivSubscriber(
  env: ReturnType<typeof getEnv>,
  email: string,
) {
  try {
    const result =
      await beehiivRequest(
        env,
        `/publications/${env.publicationId}` +
        `/subscriptions/by_email/${encodeURIComponent(email)}` +
        `?expand[]=custom_fields`,
      );

    return result.data || null;
  } catch (error) {
    if (
      (error as any)?.status === 404
    ) {
      return null;
    }

    throw error;
  }
}


/* ============================================================
   CREATE SUBSCRIBER
============================================================ */

async function createBeehiivSubscriber(
  env: ReturnType<typeof getEnv>,
  email: string,
  customFields: any[],
  automationIds: string[],
) {
  const body: any = {
    email,
    reactivate_existing: false,
    send_welcome_email: false,
    utm_source: "shopify",
    utm_medium: "ecommerce",
    utm_campaign:
      "shopify_purchase",
    custom_fields:
      customFields,
  };

  if (automationIds.length) {
    body.automation_ids =
      automationIds;
  }

  return beehiivRequest(
    env,
    `/publications/${env.publicationId}/subscriptions`,
    {
      method: "POST",
      body:
        JSON.stringify(body),
    },
  );
}


/* ============================================================
   UPDATE SUBSCRIBER BY EMAIL
============================================================ */

async function updateBeehiivSubscriber(
  env: ReturnType<typeof getEnv>,
  email: string,
  customFields: any[],
) {
  return beehiivRequest(
    env,
    `/publications/${env.publicationId}` +
    `/subscriptions/by_email/${encodeURIComponent(email)}`,
    {
      method: "PUT",
      body:
        JSON.stringify({
          email,
          custom_fields:
            customFields,
        }),
    },
  );
}


/* ============================================================
   TRIGGER BEEHIIV AUTOMATION
============================================================ */

async function triggerBeehiivAutomation(
  env: ReturnType<typeof getEnv>,
  email: string,
  automationId: string,
) {
  return beehiivRequest(
    env,
    `/publications/${env.publicationId}` +
    `/automations/${automationId}/journeys`,
    {
      method: "POST",
      body:
        JSON.stringify({
          email,
        }),
    },
  );
}
