---
title: Riverbend Wellness
path: ""
description: An example home page for the offline authoring fixture.
---

```component:hero-section
{
  "overline": "Riverbend Wellness · Elm Harbor",
  "title": "An example site you can validate before you have one.",
  "titleSize": "display",
  "lead": "Riverbend Wellness is invented. It exists so taproot-site validate has a complete workspace to check on a machine that has never pulled a real site.",
  "primaryAction": {
    "label": "Visit the studio",
    "url": "/visit"
  },
  "secondaryAction": {
    "label": "Book a class",
    "url": "https://schedule.example.test/riverbend"
  },
  "alignment": "start",
  "media": {
    "imageId": "a0000000-0000-4000-8000-0000000000a2",
    "src": "https://static.example.test/site/img/riverbend-studio-1280.webp",
    "urls": [
      {
        "minWidth": 640,
        "url": "https://static.example.test/site/img/riverbend-studio-640.webp"
      },
      {
        "minWidth": 1280,
        "url": "https://static.example.test/site/img/riverbend-studio-1280.webp"
      }
    ],
    "width": 1600,
    "height": 1067,
    "alt": "An example photograph placeholder for the fixture studio"
  },
  "mediaArrangement": "split",
  "mediaPosition": "after",
  "mediaWidth": "equal"
}
```

:::section {"context":"subtle","contentPadding":"standard","surface":"none"}
## What this fixture is for

Every value here is fictional. The studio, the street, the telephone number,
and the image delivery host are all invented, and the image identities are
declared in `manifest.fixture.json` under the `fixture` block so `validate`
can bind them without a network.

Run `taproot-site help fixture` for the manifest contract this directory
follows, and `taproot-site help page free-form` for the document vocabulary
these pages are written in.

```inline-facts
[
  {
    "value": "2 pages",
    "label": "Free-form sources"
  },
  {
    "value": "(555) 555-0147",
    "label": "Reserved example number",
    "url": "tel:+15555550147"
  },
  {
    "value": "12 Alder Street, Elm Harbor",
    "label": "Invented address"
  }
]
```
:::

:::section {"context":"inverted","contentPadding":"standard","surface":"none"}
## Change one thing and watch it fail

The fastest way to learn the contract is to break it. Point a navigation item
at a resource identity this fixture does not declare, or set
`defaultScheme` to a value outside `system`, `light`, and `dark`, and
`validate` names the file and the field it refused.

```component:cta
{
  "heading": "Then put it back.",
  "description": "Copy this directory somewhere writable before you edit it; validate never writes to the fixture it reads.",
  "buttonText": "Visit the studio",
  "buttonUrl": "/visit",
  "variant": "primary"
}
```
:::
