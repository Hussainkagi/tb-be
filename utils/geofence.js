/**
 * Geofence check for check-in and check-out.
 *
 * A branch may be reached at its own coordinates or at any of its active
 * extra sites (branch_locations), each with its own radius. Being inside any
 * one of them is enough.
 */

/** Haversine distance in metres. */
function distanceInMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** The branch itself plus its sites, as one list of circles. */
function allowedPlaces(branch, sites = []) {
    const places = [];
    if (branch?.latitude != null && branch?.longitude != null) {
        places.push({
            id: null,
            name: branch.branch_name || "Branch office",
            latitude: Number(branch.latitude),
            longitude: Number(branch.longitude),
            radius: Number(branch.attendance_radius),
        });
    }
    for (const site of sites) {
        places.push({
            id: site.id,
            name: site.location_name,
            latitude: Number(site.latitude),
            longitude: Number(site.longitude),
            radius: Number(site.attendance_radius),
        });
    }
    return places;
}

/**
 * @returns {{ configured: boolean, allowed: boolean, place?: object, distance?: number, message?: string }}
 *   `place` is the site the employee is inside of, or, when refused, the one
 *   they are closest to entering.
 */
function checkGeofence(latitude, longitude, branch, sites = []) {
    const places = allowedPlaces(branch, sites);
    if (places.length === 0) {
        return { configured: false, allowed: false, message: "Branch location is not configured" };
    }

    const measured = places.map((place) => ({
        place,
        distance: Math.round(distanceInMeters(latitude, longitude, place.latitude, place.longitude)),
    }));

    const inside = measured
        .filter((m) => m.distance <= m.place.radius)
        .sort((a, b) => a.distance - b.distance)[0];
    if (inside) return { configured: true, allowed: true, place: inside.place, distance: inside.distance };

    // Nearest by how far outside its edge, so a large-radius site that is
    // almost reached is reported ahead of a small one that is closer.
    const nearest = measured.sort(
        (a, b) => a.distance - a.place.radius - (b.distance - b.place.radius)
    )[0];

    const message = places.length === 1
        ? `You are outside the allowed radius. Your distance: ${nearest.distance}m, Allowed: ${nearest.place.radius}m`
        : `You are not at any of your branch's check-in locations. Nearest is ${nearest.place.name}: ${nearest.distance}m away, allowed within ${nearest.place.radius}m.`;

    return { configured: true, allowed: false, place: nearest.place, distance: nearest.distance, message };
}

module.exports = { distanceInMeters, allowedPlaces, checkGeofence };
