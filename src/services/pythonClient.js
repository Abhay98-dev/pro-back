import { config } from "../config.js";

async function postJson(path, body) {

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      config.pythonTimeoutMs
    );

  try {

    const response =
      await fetch(
        `${config.pythonServiceUrl}${path}`,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify(body),

          signal: controller.signal
        }
      );


    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error(
        `Python returned invalid JSON`
      );
    }


    if (!response.ok) {

      const error =
        new Error(
          data.message ||
          `Python service returned HTTP ${response.status}`
        );

      error.status =
        response.status;

      throw error;
    }


    return data;

  } finally {

    clearTimeout(timeout);

  }
}


export function detect(body) {
  return postJson(
    "/detect",
    body
  );
}


export function hindcast(body) {
  return postJson(
    "/hindcast",
    body
  );
}
