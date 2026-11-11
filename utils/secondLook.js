// "Second look" = the extra-look add-ons: Hindu extra look 1-3 and Christian
// Manthrakodi look 1-3. Add-ons are admin-managed records, so they are
// recognised by name; adjust this pattern if those add-ons are ever renamed.
// (The app keeps the same pattern in features/sales/utils/second_look.dart.)
export const SECOND_LOOK_RX =
  /manthra?\s*kodi|mantra\s*kodi|(hindu|extra|second|2nd)\W+(\w+\W+){0,3}look/i;

// Mongo condition: the booking has a second-look add-on, either at booking
// level or inside one of its package lines.
export const secondLookCondition = () => ({
  $or: [
    { 'addons.service': SECOND_LOOK_RX },
    { 'bookingItems.addons.service': SECOND_LOOK_RX },
  ],
});
