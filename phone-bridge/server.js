const express = require("express");
const { chromium } = require("playwright");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const PORTAL =
  "https://mineralsportal.jharkhand.gov.in/portal/epass/ViewPassDetailsNew.aspx";

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const sessions = new Map();
let browserPromise = null;


/* =====================================================
   BASIC FUNCTIONS
===================================================== */

function clean(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function real(value) {
  return (
    !!value &&
    clean(value).toUpperCase() !== "NA" &&
    clean(value) !== ""
  );
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true
    });
  }

  return browserPromise;
}


/* =====================================================
   SEARCH MAIN PAGE + IFRAMES
===================================================== */

async function findAcrossFrames(page, finder) {
  for (const frame of page.frames()) {
    try {
      const result = await finder(frame);

      if (result) {
        return {
          locator: result,
          frame: frame
        };
      }
    } catch (e) {
      // continue
    }
  }

  return null;
}


/* =====================================================
   CHALLAN INPUT

   VERIFIED FROM DEBUG:
   ID   = txtPassNo
   NAME = txtPassNo
===================================================== */

async function findChallanInput(page) {
  return await findAcrossFrames(page, async (frame) => {
    const selectors = [
      "#txtPassNo",
      'input[name="txtPassNo"]'
    ];

    for (const selector of selectors) {
      const loc = frame.locator(selector).first();

      if (
        await loc.count() &&
        await loc.isVisible()
      ) {
        return loc;
      }
    }

    return null;
  });
}


/* =====================================================
   CAPTCHA INPUT

   VERIFIED FROM DEBUG:
   ID   = txtCaptcha
   NAME = txtCaptcha
===================================================== */

async function findCaptchaInput(page) {
  return await findAcrossFrames(page, async (frame) => {
    const selectors = [
      "#txtCaptcha",
      'input[name="txtCaptcha"]'
    ];

    for (const selector of selectors) {
      const loc = frame.locator(selector).first();

      if (
        await loc.count() &&
        await loc.isVisible()
      ) {
        return loc;
      }
    }

    return null;
  });
}


/* =====================================================
   SEARCH BUTTON

   VERIFIED FROM DEBUG:
   ID    = btnSearch
   NAME  = btnSearch
   VALUE = Search
===================================================== */

async function findSearchButton(page) {
  return await findAcrossFrames(page, async (frame) => {
    const selectors = [
      "#btnSearch",
      'input[name="btnSearch"]',
      'input[value="Search"]'
    ];

    for (const selector of selectors) {
      const loc = frame.locator(selector).first();

      if (
        await loc.count() &&
        await loc.isVisible()
      ) {
        return loc;
      }
    }

    return null;
  });
}


/* =====================================================
   CAPTCHA IMAGE
===================================================== */

async function findCaptchaImage(page) {
  return await findAcrossFrames(page, async (frame) => {
    const images = frame.locator("img");

    const count = await images.count();

    let fallback = null;

    for (let i = 0; i < count; i++) {
      const img = images.nth(i);

      try {
        const info = await img.evaluate((x) => ({
          src: x.src || "",
          alt: x.alt || "",
          id: x.id || "",
          name: x.getAttribute("name") || "",
          width: x.naturalWidth || 0,
          height: x.naturalHeight || 0
        }));

        const text = `
          ${info.src}
          ${info.alt}
          ${info.id}
          ${info.name}
        `.toLowerCase();

        if (
          /captcha|verification|security/.test(text)
        ) {
          return img;
        }

        if (
          info.width >= 80 &&
          info.width <= 500 &&
          info.height >= 20 &&
          info.height <= 180
        ) {
          fallback = img;
        }

      } catch (e) {
        // continue
      }
    }

    return fallback;
  });
}


/* =====================================================
   RESULT LABELS
===================================================== */

const LABELS = {

  pass: [
    "Pass No."
  ],

  permit: [
    "Permit No."
  ],

  date: [
    "Challan Date"
  ],

  consigner: [
    "Consigner Name"
  ],

  generate: [
    "Challan Generate from",
    "Challan Generate From"
  ],

  location: [
    "Location"
  ],

  destination: [
    "Destination"
  ],

  vehicle: [
    "Vehicle No."
  ],

  mineral: [
    "Mineral Name"
  ],

  quantity: [
    "Quantity"
  ],

  validity: [
    "Pass Validity"
  ]

};


/* =====================================================
   EXTRACT RESULT
===================================================== */

async function extractData(page, challan) {

  const data = {
    challan: challan
  };

  let body = "";

  for (const frame of page.frames()) {
    try {
      body +=
        "\n" +
        await frame
          .locator("body")
          .innerText();
    } catch (e) {}
  }

  body = clean(body);


  for (
    const [key, labels]
    of Object.entries(LABELS)
  ) {

    let value = "";


    for (const label of labels) {

      const result =
        await findAcrossFrames(
          page,
          async (frame) => {

            const loc =
              frame
                .getByText(
                  label,
                  {
                    exact: true
                  }
                )
                .first();

            if (
              await loc.count()
            ) {
              return loc;
            }

            return null;
          }
        );


      if (!result) {
        continue;
      }


      value =
        await result.locator.evaluate(
          (node, label) => {

            function tidy(v) {
              return String(v ?? "")
                .replace(
                  /\u00a0/g,
                  " "
                )
                .replace(
                  /[\t\r\n]+/g,
                  " "
                )
                .replace(
                  /\s+/g,
                  " "
                )
                .trim();
            }


            const candidates = [

              node.nextElementSibling,

              node.parentElement
                ?.nextElementSibling,

              node.closest("tr")
                ?.querySelector(
                  "td:last-child"
                ),

              node.parentElement
                ?.querySelector(
                  "td:last-child"
                )

            ];


            for (
              const candidate
              of candidates
            ) {

              const text =
                tidy(
                  candidate?.innerText ||
                  candidate?.textContent ||
                  ""
                );


              if (
                text &&
                text.toUpperCase() !==
                  "NA" &&
                text.toLowerCase() !==
                  label.toLowerCase()
              ) {

                return text;

              }

            }


            let parent =
              node.parentElement;


            for (
              let depth = 0;
              parent && depth < 6;
              depth++,
              parent =
                parent.parentElement
            ) {

              const text =
                tidy(
                  parent.innerText ||
                  parent.textContent ||
                  ""
                );


              const escaped =
                label.replace(
                  /[.*+?^${}()|[\]\\]/g,
                  "\\$&"
                );


              const regex =
                new RegExp(
                  escaped +
                  "\\s*[:\\-]?\\s*(.*)",
                  "i"
                );


              const match =
                text.match(regex);


              if (
                match &&
                match[1] &&
                match[1].toUpperCase() !==
                  "NA"
              ) {

                return match[1].trim();

              }

            }


            return "";

          },
          label
        )
        .catch(() => "");


      if (value) {
        break;
      }

    }


    /* Quantity fallback */

    if (
      key === "quantity" &&
      !value
    ) {

      const match =
        body.match(
          /Quantity[\s\S]{0,250}?([0-9][0-9,]*(?:\.\d+)?\s*(?:Cft|Cu\.?\s*Ft|CUM|Cum|MT|Ton|Tonne|Kg))/i
        );


      if (match) {
        value =
          clean(match[1]);
      }

    }


    data[key] =
      clean(value);

  }


  return data;
}


/* =====================================================
   HOME
===================================================== */

app.get(
  "/",
  (req, res) => {

    const testFile =
      path.join(
        __dirname,
        "test.html"
      );


    res.sendFile(
      testFile,
      (error) => {

        if (error) {

          res.status(404).send(`
            <h2>Sentu Jharkhand Phone Bridge</h2>
            <p>Bridge is running.</p>
            <p>test.html file not found.</p>
          `);

        }

      }
    );

  }
);


/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      service:
        "sentu-jharkhand-phone-bridge",

      version:
        "2.2.0"

    });

  }
);


/* =====================================================
   START VERIFICATION
===================================================== */

app.post(
  "/api/start",
  async (req, res) => {

    const challan =
      clean(
        req.body?.challan
      );


    if (!challan) {

      return res
        .status(400)
        .json({

          ok: false,

          error:
            "Challan number required"

        });

    }


    let context = null;


    try {

      console.log(
        "\nOpening Jharkhand portal..."
      );


      const browser =
        await getBrowser();


      context =
        await browser.newContext();


      const page =
        await context.newPage();


      await page.goto(
        PORTAL,
        {
          waitUntil:
            "domcontentloaded",

          timeout:
            60000
        }
      );


      await page.waitForTimeout(
        1500
      );


      console.log(
        "Portal URL:",
        page.url()
      );


      /* Find Challan */

      const input =
        await findChallanInput(
          page
        );


      if (!input) {

        throw new Error(
          "Challan input not found on official portal"
        );

      }


      console.log(
        "Challan input found."
      );


      await input.locator.fill(
        challan
      );


      console.log(
        "Challan entered:",
        challan
      );


      /* Find CAPTCHA */

      const captchaImg =
        await findCaptchaImage(
          page
        );


      if (!captchaImg) {

        throw new Error(
          "CAPTCHA image not found on official portal"
        );

      }


      const captchaBuffer =
        await captchaImg
          .locator
          .screenshot({
            type: "png"
          });


      console.log(
        "CAPTCHA image found."
      );


      /* Create session */

      const sessionId =
        crypto.randomUUID();


      sessions.set(
        sessionId,
        {

          context:
            context,

          page:
            page,

          challan:
            challan,

          created:
            Date.now()

        }
      );


      /* Session expires after 10 minutes */

      setTimeout(
        async () => {

          const session =
            sessions.get(
              sessionId
            );


          if (session) {

            sessions.delete(
              sessionId
            );


            await session.context
              .close()
              .catch(() => {});

          }

        },
        10 * 60 * 1000
      );


      res.json({

        ok: true,

        sessionId:
          sessionId,

        challan:
          challan,

        captcha:
          "data:image/png;base64," +
          captchaBuffer.toString(
            "base64"
          )

      });


    } catch (error) {

      if (context) {

        await context
          .close()
          .catch(() => {});

      }


      console.error(
        "START ERROR:",
        error.message
      );


      res
        .status(500)
        .json({

          ok: false,

          error:
            error.message

        });

    }

  }
);


/* =====================================================
   VERIFY CAPTCHA
===================================================== */

app.post(
  "/api/verify",
  async (req, res) => {

    const {
      sessionId,
      captcha
    } = req.body || {};


    const session =
      sessions.get(
        sessionId
      );


    if (!session) {

      return res
        .status(400)
        .json({

          ok: false,

          error:
            "Session expired. Start verification again."

        });

    }


    if (!clean(captcha)) {

      return res
        .status(400)
        .json({

          ok: false,

          error:
            "CAPTCHA required"

        });

    }


    try {

      console.log(
        "\nFinding CAPTCHA input..."
      );


      const captchaInput =
        await findCaptchaInput(
          session.page
        );


      if (!captchaInput) {

        throw new Error(
          "CAPTCHA input not found"
        );

      }


      console.log(
        "CAPTCHA input found."
      );


      await captchaInput.locator.fill(
        clean(captcha)
      );


      console.log(
        "CAPTCHA entered."
      );


      /* Search */

      const searchButton =
        await findSearchButton(
          session.page
        );


      if (!searchButton) {

        throw new Error(
          "Search button not found"
        );

      }


      console.log(
        "Search button found."
      );


      await searchButton.locator.click();


      await session.page.waitForTimeout(
        2500
      );


      console.log(
        "Extracting result..."
      );


      const data =
        await extractData(
          session.page,
          session.challan
        );


      console.log(
        "Vehicle :",
        data.vehicle ||
          "EMPTY"
      );


      console.log(
        "Quantity:",
        data.quantity ||
          "EMPTY"
      );


      /* =================================================
         SUCCESS ONLY IF VEHICLE + QUANTITY ARE REAL
      ================================================= */

      if (
        !real(data.vehicle) ||
        !real(data.quantity)
      ) {

        let body = "";


        for (
          const frame
          of session.page.frames()
        ) {

          try {

            body +=
              "\n" +
              await frame
                .locator("body")
                .innerText();

          } catch (e) {}

        }


        const errorFound =
          /invalid|incorrect|wrong|captcha|not found|no record/i
            .test(body);


        return res
          .status(422)
          .json({

            ok: false,

            error:
              errorFound
                ? "CAPTCHA incorrect or challan not found. Please try again."
                : "Verification did not return a complete result.",

            partial:
              data

          });

      }


      data.source =
        "Jharkhand Minerals Portal";


      data.importedAt =
        new Date().toISOString();


      await session.context
        .close()
        .catch(() => {});


      sessions.delete(
        sessionId
      );


      console.log(
        "\nVERIFICATION SUCCESS"
      );


      res.json({

        ok: true,

        data:
          data

      });


    } catch (error) {

      console.error(
        "VERIFY ERROR:",
        error.message
      );


      res
        .status(500)
        .json({

          ok: false,

          error:
            error.message

        });

    }

  }
);


/* =====================================================
   SERVER START
===================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      `Sentu bridge v2.2 listening on ${PORT}`
    );

  }
);
