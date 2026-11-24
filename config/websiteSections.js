// Registry of every editable section of the public website.
// The backend validates saves against it and the CRM builds its editors from it
// (GET /api/website/admin/schema), so a field is defined exactly once.
//
// Field types:
//   text      single line, plain text (no HTML)      { maxLength }
//   textarea  multi-line plain text                   { maxLength }
//   url       https link or a site path like /book    { maxLength }
//   email | phone
//   number    { min, max }
//   image     { rule } → key of UPLOAD_RULES; value is { url, publicId, width, height, alt }
//   list      { maxItems, fields: {...} } → array of objects
//   keyedText { maxLength } → object of id → short text (e.g. one cell per package)
//
// Top-level fields are never required: a field left empty keeps showing the
// website's current (built-in) content, so staff can change just one thing.
// `required: true` is used only INSIDE list items (e.g. an FAQ question needs
// its answer) and is checked when publishing.

export const GALLERY_CATEGORIES = [
  { key: 'makeup', label: 'Bridal Makeup' },
  { key: 'hair', label: 'Hairstyling' },
  { key: 'styling', label: 'Styling' },
  { key: 'events', label: 'Reception & Events' },
];

const eyebrow = { type: 'text', label: 'Small heading', maxLength: 40 };
const heading = { type: 'text', label: 'Heading', maxLength: 80 };

// Search & sharing settings for one page of the website (marketing team).
// Empty fields fall back to the site-wide "SEO & sharing" section.
const pageSeo = (pageLabel, page) => ({
  label: `SEO — ${pageLabel}`,
  page,
  fields: {
    title: { type: 'text', label: 'Meta title (Google result + browser tab, ~50–60 characters)', maxLength: 70 },
    description: {
      type: 'textarea',
      label: 'Meta description (Google snippet, ~140–160 characters)',
      maxLength: 160,
    },
    keywords: { type: 'text', label: 'Keywords (comma separated)', maxLength: 200 },
    shareTitle: { type: 'text', label: 'Title when shared on WhatsApp / Facebook (optional)', maxLength: 90 },
    shareDescription: { type: 'textarea', label: 'Description when shared (optional)', maxLength: 200 },
    shareImage: { type: 'image', label: 'Image when this page is shared (optional)', rule: 'shareImage' },
  },
});

export const WEBSITE_SECTIONS = {
  hero: {
    label: 'Hero (top of home page)',
    page: 'home',
    fields: {
      title: { type: 'text', label: 'Title', maxLength: 60 },
      subtitle: { type: 'textarea', label: 'Subtitle', maxLength: 200 },
      ctaLabel: { type: 'text', label: 'Button text', maxLength: 30 },
      imageDesktop: { type: 'image', label: 'Background (desktop)', rule: 'heroDesktop' },
      imageMobile: { type: 'image', label: 'Background (mobile)', rule: 'heroMobile' },
      stats: {
        type: 'list',
        label: 'Counters',
        maxItems: 3,
        fields: {
          value: { type: 'number', label: 'Number', min: 0, max: 1000000, required: true },
          suffix: { type: 'text', label: 'After number (e.g. +)', maxLength: 3 },
          label: { type: 'text', label: 'Label', maxLength: 30, required: true },
        },
      },
    },
  },

  availabilityStrip: {
    label: 'Open dates strip',
    page: 'home',
    fields: {
      eyebrow,
      title: { type: 'text', label: 'Heading', maxLength: 40 },
      ctaLabel: { type: 'text', label: 'Button text', maxLength: 30 },
    },
  },

  intro: {
    label: 'Introduction',
    page: 'home',
    fields: {
      eyebrow,
      title: heading,
      body: { type: 'textarea', label: 'Text', maxLength: 400 },
      image: { type: 'image', label: 'Photo', rule: 'portrait' },
      highlights: {
        type: 'list',
        label: 'Highlights',
        maxItems: 3,
        fields: {
          label: { type: 'text', label: 'Title', maxLength: 30, required: true },
          text: { type: 'textarea', label: 'Text', maxLength: 160, required: true },
        },
      },
    },
  },

  recentBrides: {
    label: 'Recent brides',
    page: 'home',
    // Photos come from Portfolio Gallery items marked "show on home".
    fields: { eyebrow, title: heading },
  },

  packagesPreview: {
    label: 'Packages preview',
    page: 'home',
    // Package cards themselves come from Packages on Website.
    fields: { eyebrow, title: heading },
  },

  about: {
    label: 'About Feeniya',
    page: 'home',
    fields: {
      eyebrow,
      title: heading,
      quote: { type: 'textarea', label: 'Quote', maxLength: 200 },
      body: { type: 'textarea', label: 'Text', maxLength: 800 },
      portrait: { type: 'image', label: 'Portrait', rule: 'portrait' },
      stats: {
        type: 'list',
        label: 'Facts',
        maxItems: 3,
        fields: {
          number: { type: 'text', label: 'Number / word', maxLength: 12, required: true },
          label: { type: 'text', label: 'Label', maxLength: 30, required: true },
        },
      },
    },
  },

  howItWorks: {
    label: 'How it works',
    page: 'home',
    fields: {
      eyebrow,
      title: heading,
      steps: {
        type: 'list',
        label: 'Steps',
        maxItems: 6,
        fields: {
          title: { type: 'text', label: 'Step title', maxLength: 40, required: true },
          text: { type: 'textarea', label: 'Step text', maxLength: 200, required: true },
        },
      },
    },
  },

  faq: {
    label: 'FAQ',
    page: 'home',
    fields: {
      eyebrow,
      title: heading,
      items: {
        type: 'list',
        label: 'Questions',
        maxItems: 20,
        fields: {
          question: { type: 'text', label: 'Question', maxLength: 120, required: true },
          answer: { type: 'textarea', label: 'Answer', maxLength: 600, required: true },
        },
      },
    },
  },

  packagesPage: {
    label: 'Packages page',
    page: 'packages',
    fields: {
      title: heading,
      intro: { type: 'textarea', label: 'Intro text', maxLength: 300 },
      comparison: {
        type: 'list',
        label: 'Comparison table rows',
        maxItems: 12,
        fields: {
          feature: { type: 'text', label: 'Feature', maxLength: 60, required: true },
          values: { type: 'keyedText', label: 'Value per package', maxLength: 80 },
        },
      },
      guarantees: {
        type: 'list',
        label: 'Why brides trust us',
        maxItems: 6,
        fields: {
          title: { type: 'text', label: 'Title', maxLength: 40, required: true },
          text: { type: 'textarea', label: 'Text', maxLength: 200, required: true },
        },
      },
    },
  },

  policies: {
    label: 'Policies',
    page: 'policies',
    fields: {
      title: heading,
      lastUpdated: { type: 'text', label: 'Last updated (e.g. 16 Nov 2026)', maxLength: 30 },
      sections: {
        type: 'list',
        label: 'Policy sections',
        maxItems: 20,
        fields: {
          heading: { type: 'text', label: 'Heading', maxLength: 80, required: true },
          body: { type: 'textarea', label: 'Text', maxLength: 3000, required: true },
        },
      },
    },
  },

  contact: {
    label: 'Contact & Footer',
    page: 'global',
    fields: {
      phone: { type: 'phone', label: 'Phone' },
      whatsapp: { type: 'phone', label: 'WhatsApp number' },
      email: { type: 'email', label: 'Email' },
      address: { type: 'textarea', label: 'Studio address', maxLength: 300 },
      mapUrl: { type: 'url', label: 'Google Maps link', maxLength: 500 },
      hours: { type: 'text', label: 'Opening hours', maxLength: 100 },
      instagramUrl: { type: 'url', label: 'Instagram', maxLength: 200 },
      facebookUrl: { type: 'url', label: 'Facebook', maxLength: 200 },
      youtubeUrl: { type: 'url', label: 'YouTube', maxLength: 200 },
      logo: { type: 'image', label: 'Logo', rule: 'logo' },
      logoWhite: { type: 'image', label: 'Logo (white, for dark backgrounds)', rule: 'logo' },
    },
  },

  seoHome: pageSeo('Home page', 'home'),
  seoPackages: pageSeo('Packages page', 'packages'),
  seoPortfolio: pageSeo('Portfolio page', 'portfolio'),
  seoBook: pageSeo('Book page', 'book'),
  seoContact: pageSeo('Contact page', 'contact'),
  seoPolicies: pageSeo('Policies page', 'policies'),

  seo: {
    label: 'SEO & sharing',
    page: 'global',
    fields: {
      siteTitle: { type: 'text', label: 'Browser tab / Google title', maxLength: 70 },
      siteDescription: { type: 'textarea', label: 'Google description', maxLength: 160 },
      shareImage: { type: 'image', label: 'Image shown when the link is shared', rule: 'shareImage' },
      favicon: { type: 'image', label: 'Favicon', rule: 'favicon' },
    },
  },
};

export const SECTION_KEYS = Object.keys(WEBSITE_SECTIONS);
export const isSectionKey = (key) => Object.prototype.hasOwnProperty.call(WEBSITE_SECTIONS, key);
