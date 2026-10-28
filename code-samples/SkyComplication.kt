/*
 * Paj Ntaub Watch - excerpts from android/wear/.../Sky.kt and SkyComplicationService.kt (Wear OS app)
 * Copyright (c) 2026 Yang Pao Thao. All rights reserved. Shared for portfolio review only.
 *
 * The problem
 *   The Wear OS face is built with Watch Face Format (WFF): declarative XML + images, no code runs
 *   on the face. But the design needs the REAL sun and moon in the sky for the wearer's location,
 *   and five skins (Colour, Gold, Silver, Copper, Diamond) that change instantly.
 *
 * The approach
 *   1. Sky.kt computes the sun's and moon's altitude/azimuth with the same low-precision
 *      astronomy the canvas engine uses (ported line for line from engine/watch.html).
 *   2. The result is packed into ONE integer:  band * 1,000,000 + sunAzimuth * 1000 + moonAzimuth
 *      (999 = below the horizon; band = how high the sun is, which picks its colour).
 *   3. A hidden complication slot on the face receives it as a RANGED_VALUE. The face's XML decodes
 *      the digits with expressions and rotates the sun / moon images to those angles.
 *   4. The same slot's MAX carries the chosen skin (10,000,000 + skin index). One face package holds
 *      every skin's artwork and shows the one MAX selects, so a skin change is a data update
 *      (requestUpdateAll) instead of installing a new face - near-instant on the watch.
 *   Floats are exact up to 16,777,216, so every value stays below that.
 */
package com.pajntaub.watch.wear

// ------------------------------------------------------------------------------------- Sky.kt
object Sky {
    private const val R = PI / 180

    /** Where we are: the saved watch location if allowed, else latitude 38 + longitude from the time zone. */
    fun place(ctx: Context): DoubleArray {
        val p = ctx.getSharedPreferences("sky", Context.MODE_PRIVATE)
        if (p.contains("lat")) return doubleArrayOf(p.getFloat("lat", 38f).toDouble(), p.getFloat("lon", 0f).toDouble())
        return doubleArrayOf(38.0, TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 3_600_000.0 * 15)
    }

    private fun days(t: Long) = t / 864e5 + 2440587.5 - 2451545          // days since J2000.0

    private fun sunRaDec(t: Long): DoubleArray {
        val n = days(t); val lm = (280.46 + 0.9856474 * n) % 360; val g = ((357.528 + 0.9856003 * n) % 360) * R
        val lam = (lm + 1.915 * sin(g) + 0.02 * sin(2 * g)) * R; val e = (23.439 - 4e-7 * n) * R
        return doubleArrayOf(atan2(cos(e) * sin(lam), cos(lam)), asin(sin(e) * sin(lam)))
    }

    private fun moonRaDec(t: Long): DoubleArray {
        val n = days(t); val e = 23.4397 * R
        val l0 = (218.316 + 13.176396 * n) * R; val m = (134.963 + 13.064993 * n) * R; val f = (93.272 + 13.22935 * n) * R
        val l = l0 + 6.289 * R * sin(m); val b = 5.128 * R * sin(f)
        return doubleArrayOf(atan2(sin(l) * cos(e) - tan(b) * sin(e), cos(l)), asin(sin(b) * cos(e) + cos(b) * sin(e) * sin(l)))
    }

    /** [altitude, azimuth from north, east-wise] in degrees. */
    private fun altAz(rd: DoubleArray, t: Long, lat: Double, lon: Double): DoubleArray {
        val n = days(t); val gmst = (280.46061837 + 360.98564736629 * n) % 360
        val h = (gmst + lon) * R - rd[0]; val la = lat * R; val dec = rd[1]
        val alt = asin(sin(la) * sin(dec) + cos(la) * cos(dec) * cos(h))
        val az = atan2(-sin(h) * cos(dec), sin(dec) * cos(la) - cos(dec) * sin(la) * cos(h))
        return doubleArrayOf(alt / R, ((az / R) + 360) % 360)
    }

    /** band * 1,000,000 + sun * 1000 + moon. Each position is degrees round the dial, or 999 = below the horizon. */
    fun code(ctx: Context, t: Long = System.currentTimeMillis()): Int {
        val (lat, lon) = place(ctx).let { it[0] to it[1] }
        fun spot(a: DoubleArray) = if (a[0] > -1) a[1].roundToInt() % 360 else 999
        val sun = altAz(sunRaDec(t), t, lat, lon)
        val band = if (sun[0] < 8) 0 else if (sun[0] < 25) 1 else 2      // low (orange-red) / golden / high (white-gold)
        return band * 1_000_000 + spot(sun) * 1000 + spot(altAz(moonRaDec(t), t, lat, lon))
    }
}

// ------------------------------------------------------------------------ SkyComplicationService.kt
class SkyComplicationService : SuspendingComplicationDataSourceService() {

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? =
        if (request.complicationType == ComplicationType.RANGED_VALUE) data(Sky.code(this), skinNumber(this)) else null

    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        if (type == ComplicationType.RANGED_VALUE) data(2 * 1_000_000 + 150 * 1000 + 999, skinNumber(this)) else null

    private fun data(code: Int, skin: Int) = RangedValueComplicationData.Builder(
        value = code.toFloat(), min = 0f, max = (SKIN_BASE + skin).toFloat(),   // MAX doubles as the skin selector
        contentDescription = PlainComplicationText.Builder("Sun and moon").build()
    ).setText(PlainComplicationText.Builder("sky").build()).build()

    companion object {
        val SKINS = listOf("colour", "gold", "silver", "copper", "diamond")   // order is part of the face's contract
        private const val SKIN_BASE = 10_000_000                            // exact as a float (< 2^24)

        fun skin(ctx: Context): String =
            ctx.getSharedPreferences("sky", Context.MODE_PRIVATE).getString("skin", null)?.takeIf { it in SKINS } ?: "colour"
        fun skinNumber(ctx: Context) = SKINS.indexOf(skin(ctx)).coerceAtLeast(0)

        /** Called by the watch app's skin picker: save, then ask the face to redraw now. */
        fun setSkin(ctx: Context, skin: String) {
            ctx.getSharedPreferences("sky", Context.MODE_PRIVATE).edit().putString("skin", skin).commit()
            update(ctx)
        }

        fun update(ctx: Context) = ComplicationDataSourceUpdateRequester
            .create(ctx, ComponentName(ctx, SkyComplicationService::class.java)).requestUpdateAll()
    }
}
